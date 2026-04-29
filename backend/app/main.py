from __future__ import annotations

import json
from typing import Any

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .database import connect, dump, init_db, row_to_dict, rows_to_dicts, utc_now
from .runner import execute_run
from .security import create_token, verify_password, verify_token


app = FastAPI(title="Enterprise API Automation Platform", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class LoginIn(BaseModel):
    email: str
    password: str


class ProjectIn(BaseModel):
    name: str
    project_key: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$")
    description: str = ""
    owner: str = ""


class EnvironmentIn(BaseModel):
    project_id: int
    name: str
    base_url: str
    variables: dict[str, Any] = Field(default_factory=dict)
    secrets: dict[str, Any] = Field(default_factory=dict)


class ApiEndpointIn(BaseModel):
    project_id: int
    name: str
    method: str
    path: str
    description: str = ""
    headers: list[dict[str, Any]] = Field(default_factory=list)
    params: list[dict[str, Any]] = Field(default_factory=list)
    body: dict[str, Any] = Field(default_factory=dict)
    tags: list[str] = Field(default_factory=list)


class TestCaseIn(BaseModel):
    project_id: int
    name: str
    description: str = ""
    priority: str = "P2"
    variables: dict[str, Any] = Field(default_factory=dict)
    steps: list[dict[str, Any]] = Field(default_factory=list)


class TestPlanIn(BaseModel):
    project_id: int
    environment_id: int
    name: str
    description: str = ""
    case_ids: list[int] = Field(default_factory=list)
    schedule: str = ""


class RunIn(BaseModel):
    plan_id: int
    environment_id: int | None = None
    trigger_source: str = "manual"


@app.on_event("startup")
def startup() -> None:
    init_db()


def require_user(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="未登录或登录已过期")
    payload = verify_token(authorization.removeprefix("Bearer ").strip())
    if not payload:
        raise HTTPException(status_code=401, detail="无效 token")
    return payload


def audit(actor: str, action: str, target: str, detail: dict[str, Any] | None = None) -> None:
    with connect() as conn:
        conn.execute(
            "INSERT INTO audit_logs(actor, action, target, detail_json, created_at) VALUES (?, ?, ?, ?, ?)",
            (actor, action, target, dump(detail or {}), utc_now()),
        )
        conn.commit()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/auth/login")
def login(data: LoginIn) -> dict[str, Any]:
    with connect() as conn:
        user = row_to_dict(conn.execute("SELECT * FROM users WHERE email = ?", (data.email,)).fetchone())
    if not user or not verify_password(data.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="账号或密码错误")
    token = create_token({"sub": user["id"], "email": user["email"], "name": user["name"], "role": user["role"]})
    return {"token": token, "user": {key: user[key] for key in ("id", "email", "name", "role")}}


@app.get("/api/me")
def me(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    return user


@app.get("/api/dashboard")
def dashboard(user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    with connect() as conn:
        counts = {
            "projects": conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0],
            "apis": conn.execute("SELECT COUNT(*) FROM api_endpoints").fetchone()[0],
            "cases": conn.execute("SELECT COUNT(*) FROM test_cases").fetchone()[0],
            "plans": conn.execute("SELECT COUNT(*) FROM test_plans").fetchone()[0],
        }
        recent_runs = rows_to_dicts(
            conn.execute(
                """
                SELECT r.*, p.name AS plan_name, pr.name AS project_name
                FROM runs r
                JOIN test_plans p ON p.id = r.plan_id
                JOIN projects pr ON pr.id = r.project_id
                ORDER BY r.created_at DESC
                LIMIT 10
                """
            ).fetchall()
        )
        runs = rows_to_dicts(conn.execute("SELECT * FROM runs ORDER BY created_at DESC LIMIT 50").fetchall())

    total = len(runs)
    passed = sum(1 for item in runs if item["status"] == "passed")
    failed = sum(1 for item in runs if item["status"] == "failed")
    avg_duration = 0
    if runs:
        durations = [item.get("summary", {}).get("duration_ms", 0) for item in runs]
        avg_duration = round(sum(durations) / len(durations))
    return {
        "counts": counts,
        "quality": {
            "total_runs": total,
            "passed_runs": passed,
            "failed_runs": failed,
            "pass_rate": round(passed / total * 100, 1) if total else 0,
            "avg_duration_ms": avg_duration,
        },
        "recent_runs": recent_runs,
    }


@app.get("/api/projects")
def list_projects(user: dict[str, Any] = Depends(require_user)) -> list[dict[str, Any]]:
    with connect() as conn:
        return rows_to_dicts(conn.execute("SELECT * FROM projects ORDER BY created_at DESC").fetchall())


@app.post("/api/projects")
def create_project(data: ProjectIn, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    now = utc_now()
    with connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO projects(name, project_key, description, owner, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (data.name, data.project_key, data.description, data.owner, now, now),
        )
        conn.commit()
        project = row_to_dict(conn.execute("SELECT * FROM projects WHERE id = ?", (cur.lastrowid,)).fetchone())
    audit(user["email"], "create", "project", {"id": project["id"]})
    return project


@app.put("/api/projects/{project_id}")
def update_project(project_id: int, data: ProjectIn, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    with connect() as conn:
        conn.execute(
            """
            UPDATE projects SET name = ?, project_key = ?, description = ?, owner = ?, updated_at = ?
            WHERE id = ?
            """,
            (data.name, data.project_key, data.description, data.owner, utc_now(), project_id),
        )
        conn.commit()
        return row_to_dict(conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone())


@app.delete("/api/projects/{project_id}")
def delete_project(project_id: int, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    with connect() as conn:
        conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        conn.commit()
    audit(user["email"], "delete", "project", {"id": project_id})
    return {"ok": True}


@app.get("/api/environments")
def list_environments(project_id: int | None = Query(default=None), user: dict[str, Any] = Depends(require_user)):
    query = "SELECT * FROM environments"
    params: tuple[Any, ...] = ()
    if project_id:
        query += " WHERE project_id = ?"
        params = (project_id,)
    query += " ORDER BY created_at DESC"
    with connect() as conn:
        return rows_to_dicts(conn.execute(query, params).fetchall())


@app.post("/api/environments")
def create_environment(data: EnvironmentIn, user: dict[str, Any] = Depends(require_user)) -> dict[str, Any]:
    now = utc_now()
    with connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO environments(project_id, name, base_url, variables_json, secrets_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (data.project_id, data.name, data.base_url, dump(data.variables), dump(data.secrets), now, now),
        )
        conn.commit()
        return row_to_dict(conn.execute("SELECT * FROM environments WHERE id = ?", (cur.lastrowid,)).fetchone())


@app.put("/api/environments/{environment_id}")
def update_environment(environment_id: int, data: EnvironmentIn, user: dict[str, Any] = Depends(require_user)):
    with connect() as conn:
        conn.execute(
            """
            UPDATE environments
            SET project_id = ?, name = ?, base_url = ?, variables_json = ?, secrets_json = ?, updated_at = ?
            WHERE id = ?
            """,
            (data.project_id, data.name, data.base_url, dump(data.variables), dump(data.secrets), utc_now(), environment_id),
        )
        conn.commit()
        return row_to_dict(conn.execute("SELECT * FROM environments WHERE id = ?", (environment_id,)).fetchone())


@app.get("/api/apis")
def list_apis(project_id: int | None = Query(default=None), user: dict[str, Any] = Depends(require_user)):
    query = "SELECT * FROM api_endpoints"
    params: tuple[Any, ...] = ()
    if project_id:
        query += " WHERE project_id = ?"
        params = (project_id,)
    query += " ORDER BY created_at DESC"
    with connect() as conn:
        return rows_to_dicts(conn.execute(query, params).fetchall())


@app.post("/api/apis")
def create_api(data: ApiEndpointIn, user: dict[str, Any] = Depends(require_user)):
    now = utc_now()
    with connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO api_endpoints(project_id, name, method, path, description, headers_json, params_json, body_json, tags_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                data.project_id,
                data.name,
                data.method.upper(),
                data.path,
                data.description,
                dump(data.headers),
                dump(data.params),
                dump(data.body),
                dump(data.tags),
                now,
                now,
            ),
        )
        conn.commit()
        return row_to_dict(conn.execute("SELECT * FROM api_endpoints WHERE id = ?", (cur.lastrowid,)).fetchone())


@app.put("/api/apis/{api_id}")
def update_api(api_id: int, data: ApiEndpointIn, user: dict[str, Any] = Depends(require_user)):
    with connect() as conn:
        conn.execute(
            """
            UPDATE api_endpoints
            SET project_id = ?, name = ?, method = ?, path = ?, description = ?, headers_json = ?, params_json = ?,
                body_json = ?, tags_json = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                data.project_id,
                data.name,
                data.method.upper(),
                data.path,
                data.description,
                dump(data.headers),
                dump(data.params),
                dump(data.body),
                dump(data.tags),
                utc_now(),
                api_id,
            ),
        )
        conn.commit()
        return row_to_dict(conn.execute("SELECT * FROM api_endpoints WHERE id = ?", (api_id,)).fetchone())


@app.delete("/api/apis/{api_id}")
def delete_api(api_id: int, user: dict[str, Any] = Depends(require_user)):
    with connect() as conn:
        conn.execute("DELETE FROM api_endpoints WHERE id = ?", (api_id,))
        conn.commit()
    return {"ok": True}


@app.get("/api/cases")
def list_cases(project_id: int | None = Query(default=None), user: dict[str, Any] = Depends(require_user)):
    query = "SELECT * FROM test_cases"
    params: tuple[Any, ...] = ()
    if project_id:
        query += " WHERE project_id = ?"
        params = (project_id,)
    query += " ORDER BY created_at DESC"
    with connect() as conn:
        return rows_to_dicts(conn.execute(query, params).fetchall())


@app.post("/api/cases")
def create_case(data: TestCaseIn, user: dict[str, Any] = Depends(require_user)):
    now = utc_now()
    with connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO test_cases(project_id, name, description, priority, variables_json, steps_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (data.project_id, data.name, data.description, data.priority, dump(data.variables), dump(data.steps), now, now),
        )
        conn.commit()
        return row_to_dict(conn.execute("SELECT * FROM test_cases WHERE id = ?", (cur.lastrowid,)).fetchone())


@app.put("/api/cases/{case_id}")
def update_case(case_id: int, data: TestCaseIn, user: dict[str, Any] = Depends(require_user)):
    with connect() as conn:
        conn.execute(
            """
            UPDATE test_cases
            SET project_id = ?, name = ?, description = ?, priority = ?, variables_json = ?, steps_json = ?, updated_at = ?
            WHERE id = ?
            """,
            (data.project_id, data.name, data.description, data.priority, dump(data.variables), dump(data.steps), utc_now(), case_id),
        )
        conn.commit()
        return row_to_dict(conn.execute("SELECT * FROM test_cases WHERE id = ?", (case_id,)).fetchone())


@app.delete("/api/cases/{case_id}")
def delete_case(case_id: int, user: dict[str, Any] = Depends(require_user)):
    with connect() as conn:
        conn.execute("DELETE FROM test_cases WHERE id = ?", (case_id,))
        conn.commit()
    return {"ok": True}


@app.get("/api/plans")
def list_plans(project_id: int | None = Query(default=None), user: dict[str, Any] = Depends(require_user)):
    query = "SELECT * FROM test_plans"
    params: tuple[Any, ...] = ()
    if project_id:
        query += " WHERE project_id = ?"
        params = (project_id,)
    query += " ORDER BY created_at DESC"
    with connect() as conn:
        return rows_to_dicts(conn.execute(query, params).fetchall())


@app.post("/api/plans")
def create_plan(data: TestPlanIn, user: dict[str, Any] = Depends(require_user)):
    now = utc_now()
    with connect() as conn:
        cur = conn.execute(
            """
            INSERT INTO test_plans(project_id, environment_id, name, description, case_ids_json, schedule, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (data.project_id, data.environment_id, data.name, data.description, dump(data.case_ids), data.schedule, now, now),
        )
        conn.commit()
        return row_to_dict(conn.execute("SELECT * FROM test_plans WHERE id = ?", (cur.lastrowid,)).fetchone())


@app.put("/api/plans/{plan_id}")
def update_plan(plan_id: int, data: TestPlanIn, user: dict[str, Any] = Depends(require_user)):
    with connect() as conn:
        conn.execute(
            """
            UPDATE test_plans
            SET project_id = ?, environment_id = ?, name = ?, description = ?, case_ids_json = ?, schedule = ?, updated_at = ?
            WHERE id = ?
            """,
            (data.project_id, data.environment_id, data.name, data.description, dump(data.case_ids), data.schedule, utc_now(), plan_id),
        )
        conn.commit()
        return row_to_dict(conn.execute("SELECT * FROM test_plans WHERE id = ?", (plan_id,)).fetchone())


@app.delete("/api/plans/{plan_id}")
def delete_plan(plan_id: int, user: dict[str, Any] = Depends(require_user)):
    with connect() as conn:
        conn.execute("DELETE FROM test_plans WHERE id = ?", (plan_id,))
        conn.commit()
    return {"ok": True}


@app.get("/api/runs")
def list_runs(project_id: int | None = Query(default=None), user: dict[str, Any] = Depends(require_user)):
    query = """
        SELECT r.*, p.name AS plan_name, pr.name AS project_name, e.name AS environment_name
        FROM runs r
        JOIN test_plans p ON p.id = r.plan_id
        JOIN projects pr ON pr.id = r.project_id
        JOIN environments e ON e.id = r.environment_id
    """
    params: tuple[Any, ...] = ()
    if project_id:
        query += " WHERE r.project_id = ?"
        params = (project_id,)
    query += " ORDER BY r.created_at DESC LIMIT 100"
    with connect() as conn:
        return rows_to_dicts(conn.execute(query, params).fetchall())


@app.get("/api/runs/{run_id}")
def get_run(run_id: int, user: dict[str, Any] = Depends(require_user)):
    with connect() as conn:
        run = row_to_dict(conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone())
    if not run:
        raise HTTPException(status_code=404, detail="运行记录不存在")
    return run


@app.post("/api/runs")
def start_run(data: RunIn, background: BackgroundTasks, user: dict[str, Any] = Depends(require_user)):
    with connect() as conn:
        plan = row_to_dict(conn.execute("SELECT * FROM test_plans WHERE id = ?", (data.plan_id,)).fetchone())
        if not plan:
            raise HTTPException(status_code=404, detail="测试计划不存在")
        environment_id = data.environment_id or plan["environment_id"]
        now = utc_now()
        cur = conn.execute(
            """
            INSERT INTO runs(project_id, plan_id, environment_id, status, trigger_source, summary_json, logs_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (plan["project_id"], data.plan_id, environment_id, "queued", data.trigger_source, "{}", "[]", now),
        )
        conn.commit()
        run_id = cur.lastrowid
    audit(user["email"], "execute", "plan", {"plan_id": data.plan_id, "run_id": run_id})
    background.add_task(execute_run, run_id)
    return {"id": run_id, "status": "queued"}


@app.get("/api/audit-logs")
def audit_logs(user: dict[str, Any] = Depends(require_user)):
    with connect() as conn:
        return rows_to_dicts(conn.execute("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100").fetchall())


@app.post("/mock/shop/login")
def mock_login(payload: dict[str, Any]) -> dict[str, Any]:
    username = payload.get("username")
    password = payload.get("password")
    if not username or not password:
        raise HTTPException(status_code=400, detail="缺少账号或密码")
    return {
        "code": 0,
        "message": "登录成功",
        "data": {"token": f"demo-token-{username}", "user": {"id": 1001, "name": username}},
    }


@app.get("/mock/shop/orders")
def mock_orders(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    if not authorization:
        raise HTTPException(status_code=401, detail="缺少 Authorization")
    return {
        "code": 0,
        "message": "ok",
        "data": {"total": 6, "pendingPayment": 2, "paid": 4, "riskLevel": "low"},
    }


@app.post("/mock/shop/cart")
def mock_cart(payload: dict[str, Any], authorization: str | None = Header(default=None)) -> dict[str, Any]:
    if not authorization:
        raise HTTPException(status_code=401, detail="缺少 Authorization")
    return {
        "code": 0,
        "message": "加入购物车成功",
        "data": {"sku": payload.get("sku"), "quantity": payload.get("quantity", 1), "cartSize": 3},
    }

