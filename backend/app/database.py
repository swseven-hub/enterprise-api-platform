import json
import os
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .security import hash_password


ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_DB_PATH = ROOT_DIR / "data" / "platform.db"
DB_PATH = Path(os.getenv("API_PLATFORM_DB", str(DEFAULT_DB_PATH)))


def utc_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    data = dict(row)
    for key, value in list(data.items()):
        if key.endswith("_json") and value:
            data[key[:-5]] = json.loads(value)
            del data[key]
    return data


def rows_to_dicts(rows: list[sqlite3.Row]) -> list[dict[str, Any]]:
    return [row_to_dict(row) for row in rows if row is not None]


def dump(value: Any) -> str:
    return json.dumps(value if value is not None else [], ensure_ascii=False)


def init_db() -> None:
    with connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'admin',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                project_key TEXT NOT NULL UNIQUE,
                description TEXT NOT NULL DEFAULT '',
                owner TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS environments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                base_url TEXT NOT NULL,
                variables_json TEXT NOT NULL DEFAULT '{}',
                secrets_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS api_endpoints (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                method TEXT NOT NULL,
                path TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                headers_json TEXT NOT NULL DEFAULT '[]',
                params_json TEXT NOT NULL DEFAULT '[]',
                body_json TEXT NOT NULL DEFAULT '{}',
                tags_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS test_cases (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                priority TEXT NOT NULL DEFAULT 'P2',
                variables_json TEXT NOT NULL DEFAULT '{}',
                steps_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS test_plans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                environment_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                case_ids_json TEXT NOT NULL DEFAULT '[]',
                schedule TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
                FOREIGN KEY(environment_id) REFERENCES environments(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                plan_id INTEGER NOT NULL,
                environment_id INTEGER NOT NULL,
                status TEXT NOT NULL,
                trigger_source TEXT NOT NULL DEFAULT 'manual',
                summary_json TEXT NOT NULL DEFAULT '{}',
                logs_json TEXT NOT NULL DEFAULT '[]',
                started_at TEXT,
                finished_at TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
                FOREIGN KEY(plan_id) REFERENCES test_plans(id) ON DELETE CASCADE,
                FOREIGN KEY(environment_id) REFERENCES environments(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS audit_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                actor TEXT NOT NULL,
                action TEXT NOT NULL,
                target TEXT NOT NULL,
                detail_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_environments_project ON environments(project_id);
            CREATE INDEX IF NOT EXISTS idx_api_project ON api_endpoints(project_id);
            CREATE INDEX IF NOT EXISTS idx_cases_project ON test_cases(project_id);
            CREATE INDEX IF NOT EXISTS idx_plans_project ON test_plans(project_id);
            CREATE INDEX IF NOT EXISTS idx_runs_project_created ON runs(project_id, created_at DESC);
            """
        )
        seed_demo(conn)


def seed_demo(conn: sqlite3.Connection) -> None:
    user_count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    if user_count == 0:
        conn.execute(
            "INSERT INTO users(email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
            ("admin@demo.local", "平台管理员", hash_password("admin123"), "admin", utc_now()),
        )

    project_count = conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0]
    if project_count > 0:
        return

    now = utc_now()
    cur = conn.execute(
        """
        INSERT INTO projects(name, project_key, description, owner, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        ("零售订单中台", "retail-core", "覆盖登录、订单、购物车等核心 API 的回归测试资产。", "质量工程部", now, now),
    )
    project_id = cur.lastrowid
    cur = conn.execute(
        """
        INSERT INTO environments(project_id, name, base_url, variables_json, secrets_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            project_id,
            "本地演示环境",
            "http://127.0.0.1:8011",
            dump({"username": "hami", "password": "123456"}),
            dump({"internalApiKey": "demo-secret-key"}),
            now,
            now,
        ),
    )
    environment_id = cur.lastrowid

    apis = [
        ("用户登录", "POST", "/mock/shop/login", "验证账号密码并返回 token", ["auth", "smoke"]),
        ("订单汇总", "GET", "/mock/shop/orders", "获取订单统计和待支付数量", ["order", "regression"]),
        ("加入购物车", "POST", "/mock/shop/cart", "把商品加入购物车", ["cart", "regression"]),
    ]
    for name, method, path, desc, tags in apis:
        conn.execute(
            """
            INSERT INTO api_endpoints(project_id, name, method, path, description, headers_json, params_json, body_json, tags_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (project_id, name, method, path, desc, "[]", "[]", "{}", dump(tags), now, now),
        )

    smoke_steps = [
        {
            "name": "登录获取 token",
            "type": "request",
            "method": "POST",
            "url": "{{base_url}}/mock/shop/login",
            "json": {"username": "{{username}}", "password": "{{password}}"},
            "extract": [{"name": "token", "path": "data.token"}],
            "assertions": [
                {"source": "status_code", "operator": "==", "expected": 200},
                {"source": "json", "path": "code", "operator": "==", "expected": 0},
            ],
        },
        {
            "name": "读取订单汇总",
            "type": "request",
            "method": "GET",
            "url": "{{base_url}}/mock/shop/orders",
            "headers": {"Authorization": "Bearer {{token}}"},
            "assertions": [
                {"source": "status_code", "operator": "==", "expected": 200},
                {"source": "json", "path": "data.total", "operator": ">=", "expected": 3},
            ],
        },
    ]
    cart_steps = [
        {
            "name": "登录获取 token",
            "type": "request",
            "method": "POST",
            "url": "{{base_url}}/mock/shop/login",
            "json": {"username": "{{username}}", "password": "{{password}}"},
            "extract": [{"name": "token", "path": "data.token"}],
            "assertions": [{"source": "status_code", "operator": "==", "expected": 200}],
        },
        {
            "name": "加入购物车",
            "type": "request",
            "method": "POST",
            "url": "{{base_url}}/mock/shop/cart",
            "headers": {"Authorization": "Bearer {{token}}"},
            "json": {"sku": "SKU-10086", "quantity": 2},
            "assertions": [
                {"source": "status_code", "operator": "==", "expected": 200},
                {"source": "json", "path": "data.quantity", "operator": "==", "expected": 2},
            ],
        },
    ]
    case_ids: list[int] = []
    for name, desc, priority, steps in [
        ("登录后查看订单汇总", "核心登录链路和订单汇总接口的冒烟验证。", "P0", smoke_steps),
        ("登录后加入购物车", "验证购物车写入接口和鉴权链路。", "P1", cart_steps),
    ]:
        cur = conn.execute(
            """
            INSERT INTO test_cases(project_id, name, description, priority, variables_json, steps_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (project_id, name, desc, priority, "{}", dump(steps), now, now),
        )
        case_ids.append(cur.lastrowid)

    conn.execute(
        """
        INSERT INTO test_plans(project_id, environment_id, name, description, case_ids_json, schedule, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            project_id,
            environment_id,
            "每日核心 API 回归",
            "覆盖登录、订单和购物车的主干接口，适合接入 CI/CD 质量门禁。",
            dump(case_ids),
            "工作日 09:30",
            now,
            now,
        ),
    )

