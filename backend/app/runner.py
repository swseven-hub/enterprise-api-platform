import json
import re
import time
from copy import deepcopy
from typing import Any
from urllib.parse import urljoin

import httpx

from .database import connect, dump, row_to_dict, rows_to_dicts, utc_now


VAR_PATTERN = re.compile(r"\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}")


def resolve_value(value: Any, context: dict[str, Any]) -> Any:
    if isinstance(value, str):
        def repl(match: re.Match[str]) -> str:
            key = match.group(1)
            return str(context.get(key, match.group(0)))

        return VAR_PATTERN.sub(repl, value)
    if isinstance(value, list):
        return [resolve_value(item, context) for item in value]
    if isinstance(value, dict):
        return {key: resolve_value(item, context) for key, item in value.items()}
    return value


def get_path(data: Any, path: str | None) -> Any:
    if not path:
        return data
    normalized = path[2:] if path.startswith("$.") else path
    cursor = data
    for part in normalized.split("."):
        if isinstance(cursor, list):
            cursor = cursor[int(part)]
        elif isinstance(cursor, dict):
            cursor = cursor.get(part)
        else:
            return None
    return cursor


def compare(actual: Any, operator: str, expected: Any) -> bool:
    if operator == "exists":
        return actual is not None
    if operator == "contains":
        return str(expected) in str(actual)
    if operator in {">", ">=", "<", "<="}:
        left = float(actual)
        right = float(expected)
        return {
            ">": left > right,
            ">=": left >= right,
            "<": left < right,
            "<=": left <= right,
        }[operator]
    if operator == "!=":
        return actual != expected
    return actual == expected


def absolute_url(base_url: str, url: str) -> str:
    if url.startswith("http://") or url.startswith("https://"):
        return url
    return urljoin(base_url.rstrip("/") + "/", url.lstrip("/"))


def execute_run(run_id: int) -> None:
    started = utc_now()
    with connect() as conn:
        run = row_to_dict(conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone())
        if not run:
            return
        conn.execute("UPDATE runs SET status = ?, started_at = ? WHERE id = ?", ("running", started, run_id))
        conn.commit()

    logs: list[dict[str, Any]] = []
    summary = {
        "total": 0,
        "passed": 0,
        "failed": 0,
        "duration_ms": 0,
        "pass_rate": 0,
        "cases": [],
    }
    start = time.perf_counter()
    final_status = "passed"

    try:
        with connect() as conn:
            run = row_to_dict(conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone())
            plan = row_to_dict(conn.execute("SELECT * FROM test_plans WHERE id = ?", (run["plan_id"],)).fetchone())
            environment = row_to_dict(
                conn.execute("SELECT * FROM environments WHERE id = ?", (run["environment_id"],)).fetchone()
            )
            case_ids = plan.get("case_ids", [])
            placeholders = ",".join("?" for _ in case_ids) or "NULL"
            rows = conn.execute(f"SELECT * FROM test_cases WHERE id IN ({placeholders})", case_ids).fetchall()
            cases = rows_to_dicts(rows)
            order = {case_id: index for index, case_id in enumerate(case_ids)}
            cases.sort(key=lambda item: order.get(item["id"], 9999))

        base_context = {
            "base_url": environment["base_url"],
            **environment.get("variables", {}),
            **environment.get("secrets", {}),
        }
        with httpx.Client(timeout=15.0) as client:
            for case in cases:
                case_summary = run_case(client, environment, case, deepcopy(base_context), logs)
                summary["cases"].append(case_summary)
                summary["total"] += 1
                if case_summary["status"] == "passed":
                    summary["passed"] += 1
                else:
                    summary["failed"] += 1
                    final_status = "failed"
    except Exception as exc:
        final_status = "failed"
        logs.append({"level": "error", "message": f"执行器异常: {exc}", "time": utc_now()})

    summary["duration_ms"] = int((time.perf_counter() - start) * 1000)
    summary["pass_rate"] = round(summary["passed"] / summary["total"] * 100, 1) if summary["total"] else 0
    finished = utc_now()
    with connect() as conn:
        conn.execute(
            """
            UPDATE runs
            SET status = ?, summary_json = ?, logs_json = ?, finished_at = ?
            WHERE id = ?
            """,
            (final_status, dump(summary), dump(logs), finished, run_id),
        )
        conn.commit()


def run_case(
    client: httpx.Client,
    environment: dict[str, Any],
    case: dict[str, Any],
    context: dict[str, Any],
    logs: list[dict[str, Any]],
) -> dict[str, Any]:
    context.update(case.get("variables", {}))
    case_start = time.perf_counter()
    status = "passed"
    step_results = []

    for index, step in enumerate(case.get("steps", []), start=1):
        step_result = run_step(client, environment, case, step, index, context)
        step_results.append(step_result)
        logs.append(step_result)
        if step_result["status"] != "passed":
            status = "failed"
            break

    return {
        "id": case["id"],
        "name": case["name"],
        "priority": case.get("priority", "P2"),
        "status": status,
        "duration_ms": int((time.perf_counter() - case_start) * 1000),
        "steps": step_results,
    }


def run_step(
    client: httpx.Client,
    environment: dict[str, Any],
    case: dict[str, Any],
    step: dict[str, Any],
    index: int,
    context: dict[str, Any],
) -> dict[str, Any]:
    started_at = utc_now()
    start = time.perf_counter()
    step_name = step.get("name") or f"步骤 {index}"
    result: dict[str, Any] = {
        "time": started_at,
        "level": "info",
        "case_id": case["id"],
        "case_name": case["name"],
        "step_index": index,
        "step_name": step_name,
        "status": "passed",
        "request": {},
        "response": {},
        "assertions": [],
        "extracts": {},
        "duration_ms": 0,
    }
    try:
        if step.get("type", "request") != "request":
            raise ValueError(f"暂不支持的步骤类型: {step.get('type')}")

        request_data = resolve_value(step, context)
        method = request_data.get("method", "GET").upper()
        url = absolute_url(environment["base_url"], request_data.get("url", ""))
        headers = request_data.get("headers") or {}
        params = request_data.get("params") or {}
        json_body = request_data.get("json")
        data_body = request_data.get("data")
        result["request"] = {
            "method": method,
            "url": url,
            "headers": mask_headers(headers),
            "params": params,
            "json": json_body,
            "data": data_body,
        }
        response = client.request(method, url, headers=headers, params=params, json=json_body, data=data_body)
        body_text = response.text
        try:
            body_json = response.json()
        except ValueError:
            body_json = None
        result["response"] = {
            "status_code": response.status_code,
            "headers": dict(response.headers),
            "body": body_json if body_json is not None else body_text,
        }

        for item in request_data.get("extract", []):
            value = get_path(body_json, item.get("path")) if body_json is not None else None
            context[item["name"]] = value
            result["extracts"][item["name"]] = value

        for assertion in request_data.get("assertions", []):
            actual = read_assertion_source(assertion, response, body_json, body_text)
            expected = resolve_value(assertion.get("expected"), context)
            operator = assertion.get("operator", "==")
            ok = compare(actual, operator, expected)
            assertion_result = {
                "source": assertion.get("source", "json"),
                "path": assertion.get("path"),
                "operator": operator,
                "expected": expected,
                "actual": actual,
                "passed": ok,
            }
            result["assertions"].append(assertion_result)
            if not ok:
                result["status"] = "failed"
        result["level"] = "error" if result["status"] == "failed" else "info"
    except Exception as exc:
        result["status"] = "failed"
        result["level"] = "error"
        result["error"] = str(exc)
    finally:
        result["duration_ms"] = int((time.perf_counter() - start) * 1000)
    return result


def read_assertion_source(assertion: dict[str, Any], response: httpx.Response, body_json: Any, body_text: str) -> Any:
    source = assertion.get("source", "json")
    if source == "status_code":
        return response.status_code
    if source == "body":
        return body_text
    if source == "header":
        return response.headers.get(assertion.get("path", ""))
    return get_path(body_json, assertion.get("path")) if body_json is not None else None


def mask_headers(headers: dict[str, Any]) -> dict[str, Any]:
    masked = {}
    for key, value in headers.items():
        if key.lower() in {"authorization", "x-api-key", "cookie"}:
            masked[key] = "***"
        else:
            masked[key] = value
    return masked

