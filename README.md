# Atlas API Automation Platform

一个从零实现的企业级 API 自动化测试平台 MVP。它包含现代前端、后端 API、SQLite 默认数据库、真实 HTTP 执行器、变量替换、提取、断言、执行报告和审计日志。

## 技术栈

- Frontend: React 18, TypeScript, Vite, Lucide icons
- Backend: FastAPI, SQLite, httpx
- Runner: 后端内置执行器，支持 HTTP 请求、上下文变量、JSON 提取和断言

## 默认账号

- 邮箱: `admin@demo.local`
- 密码: `admin123`

## 本地启动

```bash
./scripts/dev.sh
```

启动后访问:

- 前端: http://127.0.0.1:5173
- 后端: http://127.0.0.1:8011
- API 文档: http://127.0.0.1:8011/docs

停止后台服务:

```bash
./scripts/stop.sh
```

## 数据说明

后端首次启动会自动创建 `backend/data/platform.db` 并写入演示项目、环境、接口、用例和测试计划。

## 企业化扩展方向

- 将 SQLite 切换为 PostgreSQL
- 将内置执行器拆分为 Celery/RQ 或 Kubernetes Job worker
- 对接 SSO/OIDC、LDAP、企业微信/飞书通知
- 引入 OpenAPI/Swagger 导入、接口覆盖率、质量门禁和趋势分析
- 将密钥字段接入 Vault/KMS
