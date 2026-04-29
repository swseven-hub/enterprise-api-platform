import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Boxes,
  CheckCircle2,
  Clock3,
  Copy,
  Database,
  FileCode2,
  Gauge,
  GitBranch,
  Layers3,
  ListChecks,
  LockKeyhole,
  LogOut,
  Play,
  Plus,
  RefreshCcw,
  Rocket,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Trash2,
  Wand2,
  XCircle
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

type Project = {
  id: number;
  name: string;
  project_key: string;
  description: string;
  owner: string;
};

type Environment = {
  id: number;
  project_id: number;
  name: string;
  base_url: string;
  variables: Record<string, unknown>;
  secrets: Record<string, unknown>;
};

type ApiEndpoint = {
  id: number;
  project_id: number;
  name: string;
  method: string;
  path: string;
  description: string;
  tags: string[];
};

type TestCase = {
  id: number;
  project_id: number;
  name: string;
  description: string;
  priority: string;
  variables: Record<string, unknown>;
  steps: Step[];
};

type Step = {
  name: string;
  type: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  json?: Record<string, unknown>;
  data?: Record<string, unknown>;
  params?: Record<string, unknown>;
  extract?: Array<{ name: string; path: string }>;
  assertions?: Array<{ source: string; path?: string; operator: string; expected?: unknown }>;
};

type CasePayload = {
  project_id: number;
  name: string;
  description: string;
  priority: string;
  variables: Record<string, unknown>;
  steps: Step[];
};

type TestPlan = {
  id: number;
  project_id: number;
  environment_id: number;
  name: string;
  description: string;
  case_ids: number[];
  schedule: string;
};

type Run = {
  id: number;
  project_id: number;
  plan_id: number;
  environment_id: number;
  status: "queued" | "running" | "passed" | "failed";
  plan_name?: string;
  project_name?: string;
  environment_name?: string;
  trigger_source: string;
  summary?: {
    total?: number;
    passed?: number;
    failed?: number;
    pass_rate?: number;
    duration_ms?: number;
    cases?: Array<Record<string, unknown>>;
  };
  logs?: Array<Record<string, unknown>>;
  created_at: string;
  started_at?: string;
  finished_at?: string;
};

type Dashboard = {
  counts: Record<string, number>;
  quality: {
    total_runs: number;
    passed_runs: number;
    failed_runs: number;
    pass_rate: number;
    avg_duration_ms: number;
  };
  recent_runs: Run[];
};

type View = "dashboard" | "projects" | "apis" | "cases" | "plans" | "runs";

const sampleSteps = [
  {
    name: "登录获取 token",
    type: "request",
    method: "POST",
    url: "{{base_url}}/mock/shop/login",
    json: { username: "{{username}}", password: "{{password}}" },
    extract: [{ name: "token", path: "data.token" }],
    assertions: [
      { source: "status_code", operator: "==", expected: 200 },
      { source: "json", path: "code", operator: "==", expected: 0 }
    ]
  },
  {
    name: "读取订单汇总",
    type: "request",
    method: "GET",
    url: "{{base_url}}/mock/shop/orders",
    headers: { Authorization: "Bearer {{token}}" },
    assertions: [
      { source: "status_code", operator: "==", expected: 200 },
      { source: "json", path: "data.total", operator: ">=", expected: 1 }
    ]
  }
];

const emptyStep = (): Step => ({
  name: "新的请求步骤",
  type: "request",
  method: "GET",
  url: "{{base_url}}/",
  headers: {},
  params: {},
  json: {},
  extract: [],
  assertions: [{ source: "status_code", operator: "==", expected: 200 }]
});

function statusLabel(status?: string) {
  return {
    queued: "排队中",
    running: "执行中",
    passed: "通过",
    failed: "失败"
  }[status ?? ""] ?? "未知";
}

function methodClass(method: string) {
  return `method ${method.toLowerCase()}`;
}

function safeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function formatMs(value?: number) {
  if (!value) return "0 ms";
  return value > 1000 ? `${(value / 1000).toFixed(2)} s` : `${value} ms`;
}

function classNames(...items: Array<string | false | undefined>) {
  return items.filter(Boolean).join(" ");
}

export default function App() {
  const [token, setToken] = useState(localStorage.getItem("api-platform-token") ?? "");
  const [userName, setUserName] = useState(localStorage.getItem("api-platform-user") ?? "");
  const [loginError, setLoginError] = useState("");
  const [view, setView] = useState<View>("dashboard");
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [apis, setApis] = useState<ApiEndpoint[]>([]);
  const [cases, setCases] = useState<TestCase[]>([]);
  const [plans, setPlans] = useState<TestPlan[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<number | "all">("all");
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [toast, setToast] = useState("");

  const projectOptions = useMemo(() => projects, [projects]);
  const activeProjectId = selectedProjectId === "all" ? projects[0]?.id : selectedProjectId;
  const filteredApis = apis.filter((item) => matchProject(item.project_id, selectedProjectId) && matchText(item, search));
  const filteredCases = cases.filter((item) => matchProject(item.project_id, selectedProjectId) && matchText(item, search));
  const filteredPlans = plans.filter((item) => matchProject(item.project_id, selectedProjectId) && matchText(item, search));
  const filteredRuns = runs.filter((item) => matchProject(item.project_id, selectedProjectId) && matchText(item, search));

  async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers ?? {})
      }
    });
    if (response.status === 401) {
      logout();
      throw new Error("登录已过期");
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.detail ?? "请求失败");
    }
    return response.json();
  }

  async function loadAll() {
    if (!token) return;
    setLoading(true);
    try {
      const [dashboardData, projectData, envData, apiData, caseData, planData, runData] = await Promise.all([
        request<Dashboard>("/api/dashboard"),
        request<Project[]>("/api/projects"),
        request<Environment[]>("/api/environments"),
        request<ApiEndpoint[]>("/api/apis"),
        request<TestCase[]>("/api/cases"),
        request<TestPlan[]>("/api/plans"),
        request<Run[]>("/api/runs")
      ]);
      setDashboard(dashboardData);
      setProjects(projectData);
      setEnvironments(envData);
      setApis(apiData);
      setCases(caseData);
      setPlans(planData);
      setRuns(runData);
      if (selectedProjectId !== "all" && !projectData.some((item) => item.id === selectedProjectId)) {
        setSelectedProjectId("all");
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll().catch((error) => showToast(error.message));
  }, [token]);

  useEffect(() => {
    if (!token) return undefined;
    const id = window.setInterval(() => {
      if (runs.some((item) => item.status === "queued" || item.status === "running")) {
        loadAll().catch(() => undefined);
      }
    }, 1800);
    return () => window.clearInterval(id);
  }, [token, runs]);

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }

  function logout() {
    localStorage.removeItem("api-platform-token");
    localStorage.removeItem("api-platform-user");
    setToken("");
    setUserName("");
  }

  async function onLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setLoginError("");
    try {
      const data = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") })
      }).then(async (response) => {
        if (!response.ok) throw new Error("账号或密码错误");
        return response.json();
      });
      localStorage.setItem("api-platform-token", data.token);
      localStorage.setItem("api-platform-user", data.user.name);
      setToken(data.token);
      setUserName(data.user.name);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "登录失败");
    }
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await request<Project>("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: form.get("name"),
        project_key: form.get("project_key"),
        description: form.get("description"),
        owner: form.get("owner")
      })
    });
    event.currentTarget.reset();
    showToast("项目已创建");
    await loadAll();
  }

  async function createEnvironment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await request<Environment>("/api/environments", {
      method: "POST",
      body: JSON.stringify({
        project_id: Number(form.get("project_id")),
        name: form.get("name"),
        base_url: form.get("base_url"),
        variables: safeJson(String(form.get("variables") ?? "{}"), {}),
        secrets: safeJson(String(form.get("secrets") ?? "{}"), {})
      })
    });
    showToast("环境已保存");
    await loadAll();
  }

  async function createApi(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await request<ApiEndpoint>("/api/apis", {
      method: "POST",
      body: JSON.stringify({
        project_id: Number(form.get("project_id")),
        name: form.get("name"),
        method: form.get("method"),
        path: form.get("path"),
        description: form.get("description"),
        tags: String(form.get("tags") ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      })
    });
    event.currentTarget.reset();
    showToast("接口已入库");
    await loadAll();
  }

  async function saveCase(payload: CasePayload, caseId?: number) {
    await request<TestCase>(caseId ? `/api/cases/${caseId}` : "/api/cases", {
      method: caseId ? "PUT" : "POST",
      body: JSON.stringify(payload)
    });
    showToast(caseId ? "用例已更新" : "用例已保存");
    await loadAll();
  }

  async function createPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const caseIds = String(form.get("case_ids") ?? "")
      .split(",")
      .map((item) => Number(item.trim()))
      .filter(Boolean);
    await request<TestPlan>("/api/plans", {
      method: "POST",
      body: JSON.stringify({
        project_id: Number(form.get("project_id")),
        environment_id: Number(form.get("environment_id")),
        name: form.get("name"),
        description: form.get("description"),
        schedule: form.get("schedule"),
        case_ids: caseIds
      })
    });
    showToast("测试计划已保存");
    await loadAll();
  }

  async function deleteItem(kind: "projects" | "apis" | "cases" | "plans", id: number) {
    await request(`/api/${kind}/${id}`, { method: "DELETE" });
    showToast("已删除");
    await loadAll();
  }

  async function startRun(plan: TestPlan) {
    const data = await request<{ id: number; status: string }>("/api/runs", {
      method: "POST",
      body: JSON.stringify({ plan_id: plan.id, environment_id: plan.environment_id, trigger_source: "manual" })
    });
    showToast(`运行 #${data.id} 已创建`);
    await loadAll();
    const run = await request<Run>(`/api/runs/${data.id}`);
    setSelectedRun(run);
    setView("runs");
  }

  if (!token) {
    return <LoginScreen onSubmit={onLogin} error={loginError} />;
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Rocket size={22} />
          </div>
          <div>
            <strong>Atlas API</strong>
            <span>Automation Platform</span>
          </div>
        </div>
        <nav>
          <NavButton icon={<Gauge />} active={view === "dashboard"} label="质量看板" onClick={() => setView("dashboard")} />
          <NavButton icon={<Boxes />} active={view === "projects"} label="项目与环境" onClick={() => setView("projects")} />
          <NavButton icon={<Server />} active={view === "apis"} label="接口资产" onClick={() => setView("apis")} />
          <NavButton icon={<ListChecks />} active={view === "cases"} label="测试用例" onClick={() => setView("cases")} />
          <NavButton icon={<GitBranch />} active={view === "plans"} label="测试计划" onClick={() => setView("plans")} />
          <NavButton icon={<Activity />} active={view === "runs"} label="执行报告" onClick={() => setView("runs")} />
        </nav>
        <div className="sidebar-footer">
          <ShieldCheck size={18} />
          <span>PBKDF2 auth</span>
          <span>Audit ready</span>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Enterprise API Quality</p>
            <h1>{pageTitle(view)}</h1>
          </div>
          <div className="topbar-tools">
            <label className="search">
              <Search size={16} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索资产、计划、报告" />
            </label>
            <select value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value === "all" ? "all" : Number(event.target.value))}>
              <option value="all">全部项目</option>
              {projectOptions.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <button className="icon-button" onClick={() => loadAll()} title="刷新">
              <RefreshCcw size={18} className={loading ? "spin" : ""} />
            </button>
            <button className="user-button" onClick={logout}>
              <span>{userName || "用户"}</span>
              <LogOut size={17} />
            </button>
          </div>
        </header>

        {view === "dashboard" && <DashboardView dashboard={dashboard} runs={runs} onOpenRun={setSelectedRun} onViewRuns={() => setView("runs")} />}
        {view === "projects" && (
          <ProjectsView
            projects={projects}
            environments={environments}
            activeProjectId={activeProjectId}
            createProject={createProject}
            createEnvironment={createEnvironment}
            deleteProject={(id) => deleteItem("projects", id)}
          />
        )}
        {view === "apis" && <ApisView projects={projects} apis={filteredApis} activeProjectId={activeProjectId} createApi={createApi} deleteApi={(id) => deleteItem("apis", id)} />}
        {view === "cases" && (
          <CasesView
            projects={projects}
            apis={apis}
            cases={filteredCases}
            activeProjectId={activeProjectId}
            saveCase={saveCase}
            deleteCase={(id) => deleteItem("cases", id)}
          />
        )}
        {view === "plans" && (
          <PlansView
            projects={projects}
            environments={environments}
            cases={cases}
            plans={filteredPlans}
            activeProjectId={activeProjectId}
            createPlan={createPlan}
            startRun={startRun}
            deletePlan={(id) => deleteItem("plans", id)}
          />
        )}
        {view === "runs" && <RunsView runs={filteredRuns} selectedRun={selectedRun} setSelectedRun={setSelectedRun} reload={loadAll} />}
      </main>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function LoginScreen({ onSubmit, error }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void; error: string }) {
  return (
    <div className="login-page">
      <section className="login-visual">
        <div className="login-metrics">
          <Metric label="最近通过率" value="98.6%" />
          <Metric label="平均回归耗时" value="42s" />
          <Metric label="API 资产" value="1,284" />
        </div>
      </section>
      <form className="login-form" onSubmit={onSubmit}>
        <div className="brand large">
          <div className="brand-mark">
            <Rocket size={24} />
          </div>
          <div>
            <strong>Atlas API</strong>
            <span>Automation Platform</span>
          </div>
        </div>
        <label>
          邮箱
          <input name="email" defaultValue="admin@demo.local" />
        </label>
        <label>
          密码
          <input name="password" type="password" defaultValue="admin123" />
        </label>
        {error && <div className="form-error">{error}</div>}
        <button className="primary-action">
          <LockKeyhole size={18} />
          登录平台
        </button>
      </form>
    </div>
  );
}

function NavButton({ icon, label, active, onClick }: { icon: JSX.Element; label: string; active: boolean; onClick: () => void }) {
  return (
    <button className={classNames("nav-button", active && "active")} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function DashboardView({ dashboard, runs, onOpenRun, onViewRuns }: { dashboard: Dashboard | null; runs: Run[]; onOpenRun: (run: Run) => void; onViewRuns: () => void }) {
  const quality = dashboard?.quality;
  return (
    <div className="content-grid dashboard-grid">
      <section className="metric-band">
        <Metric icon={<Boxes />} label="项目" value={dashboard?.counts.projects ?? 0} />
        <Metric icon={<Server />} label="接口" value={dashboard?.counts.apis ?? 0} />
        <Metric icon={<ListChecks />} label="用例" value={dashboard?.counts.cases ?? 0} />
        <Metric icon={<GitBranch />} label="计划" value={dashboard?.counts.plans ?? 0} />
      </section>

      <section className="panel quality-panel">
        <div className="section-title">
          <div>
            <p className="eyebrow">Quality Gate</p>
            <h2>回归健康度</h2>
          </div>
          <span className="score">{quality?.pass_rate ?? 0}%</span>
        </div>
        <div className="progress-track">
          <span style={{ width: `${quality?.pass_rate ?? 0}%` }} />
        </div>
        <div className="quality-row">
          <Metric label="运行次数" value={quality?.total_runs ?? 0} />
          <Metric label="通过" value={quality?.passed_runs ?? 0} tone="ok" />
          <Metric label="失败" value={quality?.failed_runs ?? 0} tone="danger" />
          <Metric label="平均耗时" value={formatMs(quality?.avg_duration_ms)} />
        </div>
      </section>

      <section className="panel wide">
        <div className="section-title">
          <h2>最近执行</h2>
          <button className="secondary-action" onClick={onViewRuns}>
            <Activity size={16} />
            报告中心
          </button>
        </div>
        <RunTable runs={runs.slice(0, 8)} onOpen={onOpenRun} />
      </section>
    </div>
  );
}

function ProjectsView({
  projects,
  environments,
  activeProjectId,
  createProject,
  createEnvironment,
  deleteProject
}: {
  projects: Project[];
  environments: Environment[];
  activeProjectId?: number;
  createProject: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  createEnvironment: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  deleteProject: (id: number) => Promise<void>;
}) {
  return (
    <div className="split">
      <section className="panel">
        <div className="section-title">
          <h2>项目空间</h2>
        </div>
        <form className="stack-form" onSubmit={createProject}>
          <input name="name" placeholder="项目名称" required />
          <input name="project_key" placeholder="项目标识，如 retail-api" required />
          <input name="owner" placeholder="负责人" />
          <textarea name="description" placeholder="项目说明" rows={3} />
          <button className="primary-action">
            <Plus size={17} />
            新建项目
          </button>
        </form>
      </section>
      <section className="panel wide">
        <DataTable
          rows={projects}
          columns={[
            ["name", "项目"],
            ["project_key", "标识"],
            ["owner", "负责人"],
            ["description", "说明"]
          ]}
          action={(row) => (
            <button className="danger-link" onClick={() => deleteProject(row.id)}>
              <Trash2 size={15} />
              删除
            </button>
          )}
        />
      </section>
      <section className="panel wide">
        <div className="section-title">
          <h2>环境与变量</h2>
        </div>
        <form className="inline-form" onSubmit={createEnvironment}>
          <select name="project_id" defaultValue={activeProjectId}>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <input name="name" placeholder="环境名称" defaultValue="测试环境" required />
          <input name="base_url" placeholder="Base URL" defaultValue="http://127.0.0.1:8011" required />
          <textarea name="variables" rows={3} defaultValue={'{"username":"hami","password":"123456"}'} />
          <textarea name="secrets" rows={3} defaultValue={'{"internalApiKey":"change-me"}'} />
          <button className="primary-action">
            <Database size={17} />
            保存环境
          </button>
        </form>
        <EnvironmentList environments={environments} />
      </section>
    </div>
  );
}

function ApisView({
  projects,
  apis,
  activeProjectId,
  createApi,
  deleteApi
}: {
  projects: Project[];
  apis: ApiEndpoint[];
  activeProjectId?: number;
  createApi: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  deleteApi: (id: number) => Promise<void>;
}) {
  return (
    <div className="split">
      <section className="panel">
        <div className="section-title">
          <h2>接口入库</h2>
        </div>
        <form className="stack-form" onSubmit={createApi}>
          <select name="project_id" defaultValue={activeProjectId}>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <input name="name" placeholder="接口名称" required />
          <div className="two-cols">
            <select name="method" defaultValue="GET">
              {["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => (
                <option key={method}>{method}</option>
              ))}
            </select>
            <input name="path" placeholder="/api/path" required />
          </div>
          <input name="tags" placeholder="标签，逗号分隔" />
          <textarea name="description" placeholder="接口说明" rows={4} />
          <button className="primary-action">
            <FileCode2 size={17} />
            保存接口
          </button>
        </form>
      </section>
      <section className="panel wide">
        <div className="asset-list">
          {apis.map((api) => (
            <div className="asset-row" key={api.id}>
              <span className={methodClass(api.method)}>{api.method}</span>
              <div>
                <strong>{api.name}</strong>
                <code>{api.path}</code>
              </div>
              <span className="muted">{api.tags?.join(" / ")}</span>
              <button className="danger-link" onClick={() => deleteApi(api.id)}>
                <Trash2 size={15} />
                删除
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function CasesView({
  projects,
  apis,
  cases,
  activeProjectId,
  saveCase,
  deleteCase
}: {
  projects: Project[];
  apis: ApiEndpoint[];
  cases: TestCase[];
  activeProjectId?: number;
  saveCase: (payload: CasePayload, caseId?: number) => Promise<void>;
  deleteCase: (id: number) => Promise<void>;
}) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [projectId, setProjectId] = useState(activeProjectId ?? projects[0]?.id ?? 0);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("P1");
  const [variablesText, setVariablesText] = useState("{}");
  const [steps, setSteps] = useState<Step[]>(() => normalizeSteps(sampleSteps));
  const [selectedApiId, setSelectedApiId] = useState("");

  useEffect(() => {
    if (!editingId && activeProjectId) {
      setProjectId(activeProjectId);
    }
  }, [activeProjectId, editingId]);

  const projectApis = apis.filter((api) => api.project_id === projectId);

  function resetEditor() {
    setEditingId(null);
    setProjectId(activeProjectId ?? projects[0]?.id ?? 0);
    setName("");
    setDescription("");
    setPriority("P1");
    setVariablesText("{}");
    setSteps([emptyStep()]);
    setSelectedApiId("");
  }

  function loadSample() {
    setSteps(normalizeSteps(sampleSteps));
  }

  function editCase(item: TestCase) {
    setEditingId(item.id);
    setProjectId(item.project_id);
    setName(item.name);
    setDescription(item.description);
    setPriority(item.priority);
    setVariablesText(JSON.stringify(item.variables ?? {}, null, 2));
    setSteps(normalizeSteps(item.steps?.length ? item.steps : [emptyStep()]));
  }

  function updateStep(index: number, nextStep: Step) {
    setSteps((current) => current.map((step, stepIndex) => (stepIndex === index ? nextStep : step)));
  }

  function removeStep(index: number) {
    setSteps((current) => current.filter((_, stepIndex) => stepIndex !== index));
  }

  function duplicateStep(index: number) {
    setSteps((current) => {
      const next = [...current];
      next.splice(index + 1, 0, { ...current[index], name: `${current[index].name} copy` });
      return next;
    });
  }

  function moveStep(index: number, direction: -1 | 1) {
    setSteps((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function addFromApiAsset() {
    const api = projectApis.find((item) => item.id === Number(selectedApiId));
    if (!api) return;
    setSteps((current) => [
      ...current,
      {
        ...emptyStep(),
        name: api.name,
        method: api.method,
        url: `{{base_url}}${api.path}`,
        assertions: [{ source: "status_code", operator: "==", expected: 200 }]
      }
    ]);
    setSelectedApiId("");
  }

  async function submitCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) {
      window.alert("请填写用例名称");
      return;
    }
    if (!projectId) {
      window.alert("请选择项目");
      return;
    }
    const variables = parseJsonObject(variablesText, "变量定义");
    if (!variables) return;
    await saveCase(
      {
        project_id: projectId,
        name,
        description,
        priority,
        variables,
        steps
      },
      editingId ?? undefined
    );
    if (!editingId) resetEditor();
  }

  return (
    <div className="case-builder-layout">
      <section className="panel case-editor-panel">
        <div className="section-title">
          <div>
            <p className="eyebrow">{editingId ? `Case #${editingId}` : "Visual Builder"}</p>
            <h2>可视化用例编排</h2>
          </div>
          <button className="secondary-action" onClick={resetEditor} type="button">
            新建
          </button>
        </div>
        <form className="case-builder" onSubmit={submitCase}>
          <div className="builder-basics">
            <select value={projectId} onChange={(event) => setProjectId(Number(event.target.value))}>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="用例名称" required />
            <select value={priority} onChange={(event) => setPriority(event.target.value)}>
              {["P0", "P1", "P2", "P3"].map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="用例说明" rows={3} />
            <textarea className="code-area" value={variablesText} onChange={(event) => setVariablesText(event.target.value)} placeholder="变量定义 JSON" rows={3} />
          </div>

          <div className="step-toolbar">
            <button type="button" className="secondary-action" onClick={() => setSteps((current) => [...current, emptyStep()])}>
              <Plus size={16} />
              添加请求步骤
            </button>
            <button type="button" className="secondary-action" onClick={loadSample}>
              <Wand2 size={16} />
              载入示例链路
            </button>
            <select value={selectedApiId} onChange={(event) => setSelectedApiId(event.target.value)}>
              <option value="">从接口资产选择</option>
              {projectApis.map((api) => (
                <option key={api.id} value={api.id}>
                  {api.method} {api.name}
                </option>
              ))}
            </select>
            <button type="button" className="secondary-action" onClick={addFromApiAsset} disabled={!selectedApiId}>
              <FileCode2 size={16} />
              生成步骤
            </button>
          </div>

          <div className="step-list">
            {steps.map((step, index) => (
              <StepCard
                key={`${index}-${step.name}`}
                step={step}
                index={index}
                total={steps.length}
                onChange={(nextStep) => updateStep(index, nextStep)}
                onRemove={() => removeStep(index)}
                onDuplicate={() => duplicateStep(index)}
                onMove={(direction) => moveStep(index, direction)}
              />
            ))}
          </div>

          <div className="builder-footer">
            <div>
              <strong>{steps.length}</strong>
              <span> 个步骤会按当前顺序执行</span>
            </div>
            <button className="primary-action">
              <Layers3 size={17} />
              {editingId ? "更新用例" : "保存用例"}
            </button>
          </div>
        </form>
      </section>
      <section className="panel case-list-panel">
        <div className="section-title">
          <h2>用例资产</h2>
        </div>
        <CaseList cases={cases} onEdit={editCase} onDelete={deleteCase} />
      </section>
    </div>
  );
}

function StepCard({
  step,
  index,
  total,
  onChange,
  onRemove,
  onDuplicate,
  onMove
}: {
  step: Step;
  index: number;
  total: number;
  onChange: (step: Step) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  const [bodyText, setBodyText] = useState(JSON.stringify(step.json ?? {}, null, 2));
  const [bodyError, setBodyError] = useState("");

  useEffect(() => {
    setBodyText(JSON.stringify(step.json ?? {}, null, 2));
    setBodyError("");
  }, [step.json]);

  function patch(patchData: Partial<Step>) {
    onChange({ ...step, ...patchData });
  }

  function commitBody() {
    try {
      const json = bodyText.trim() ? JSON.parse(bodyText) : {};
      setBodyError("");
      patch({ json });
    } catch {
      setBodyError("JSON 格式不正确，修正后会写入步骤");
    }
  }

  return (
    <article className="step-card">
      <div className="step-card-head">
        <span className="step-index">{index + 1}</span>
        <input value={step.name} onChange={(event) => patch({ name: event.target.value })} placeholder="步骤名称" />
        <div className="step-actions">
          <button type="button" className="icon-button small" onClick={() => onMove(-1)} disabled={index === 0} title="上移">
            <ArrowUp size={15} />
          </button>
          <button type="button" className="icon-button small" onClick={() => onMove(1)} disabled={index === total - 1} title="下移">
            <ArrowDown size={15} />
          </button>
          <button type="button" className="icon-button small" onClick={onDuplicate} title="复制">
            <Copy size={15} />
          </button>
          <button type="button" className="icon-button small danger" onClick={onRemove} title="删除">
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      <div className="request-line">
        <select value={step.method} onChange={(event) => patch({ method: event.target.value })}>
          {["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => (
            <option key={method}>{method}</option>
          ))}
        </select>
        <input value={step.url} onChange={(event) => patch({ url: event.target.value })} placeholder="{{base_url}}/api/path" />
      </div>

      <div className="step-sections">
        <details open>
          <summary>Headers</summary>
          <KeyValueEditor value={step.headers ?? {}} onChange={(headers) => patch({ headers: headers as Record<string, string> })} keyPlaceholder="Header" valuePlaceholder="Value" />
        </details>
        <details>
          <summary>Params</summary>
          <KeyValueEditor value={step.params ?? {}} onChange={(params) => patch({ params })} keyPlaceholder="Param" valuePlaceholder="Value" />
        </details>
        <details open={step.method !== "GET"}>
          <summary>JSON Body</summary>
          <textarea className="code-area" value={bodyText} onChange={(event) => setBodyText(event.target.value)} onBlur={commitBody} rows={6} />
          {bodyError && <div className="field-error">{bodyError}</div>}
        </details>
        <details>
          <summary>变量提取</summary>
          <ExtractEditor value={step.extract ?? []} onChange={(extract) => patch({ extract })} />
        </details>
        <details open>
          <summary>断言</summary>
          <AssertionEditor value={step.assertions ?? []} onChange={(assertions) => patch({ assertions })} />
        </details>
      </div>
    </article>
  );
}

function KeyValueEditor({
  value,
  onChange,
  keyPlaceholder,
  valuePlaceholder
}: {
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
}) {
  const entries = Object.entries(value ?? {});

  function updateEntry(index: number, key: string, rawValue: string) {
    const next = entries.map(([currentKey, currentValue], currentIndex) =>
      currentIndex === index ? [key, parseLiteral(rawValue)] : [currentKey, currentValue]
    );
    onChange(Object.fromEntries(next.filter(([entryKey]) => String(entryKey).trim())));
  }

  return (
    <div className="kv-editor">
      {entries.map(([key, itemValue], index) => (
        <div className="kv-row" key={`${key}-${index}`}>
          <input value={key} onChange={(event) => updateEntry(index, event.target.value, stringifyInput(itemValue))} placeholder={keyPlaceholder} />
          <input value={stringifyInput(itemValue)} onChange={(event) => updateEntry(index, key, event.target.value)} placeholder={valuePlaceholder} />
          <button type="button" className="danger-link" onClick={() => onChange(Object.fromEntries(entries.filter((_, entryIndex) => entryIndex !== index)))}>
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      <button type="button" className="secondary-action" onClick={() => onChange({ ...value, "": "" })}>
        <Plus size={15} />
        添加字段
      </button>
    </div>
  );
}

function ExtractEditor({
  value,
  onChange
}: {
  value: Array<{ name: string; path: string }>;
  onChange: (value: Array<{ name: string; path: string }>) => void;
}) {
  return (
    <div className="kv-editor">
      {value.map((item, index) => (
        <div className="extract-row" key={`${item.name}-${index}`}>
          <input value={item.name} onChange={(event) => onChange(updateArray(value, index, { ...item, name: event.target.value }))} placeholder="变量名，如 token" />
          <input value={item.path} onChange={(event) => onChange(updateArray(value, index, { ...item, path: event.target.value }))} placeholder="JSON 路径，如 data.token" />
          <button type="button" className="danger-link" onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}>
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      <button type="button" className="secondary-action" onClick={() => onChange([...value, { name: "", path: "" }])}>
        <Plus size={15} />
        添加提取
      </button>
    </div>
  );
}

function AssertionEditor({
  value,
  onChange
}: {
  value: Array<{ source: string; path?: string; operator: string; expected?: unknown }>;
  onChange: (value: Array<{ source: string; path?: string; operator: string; expected?: unknown }>) => void;
}) {
  return (
    <div className="assertion-editor">
      {value.map((item, index) => (
        <div className="assertion-row" key={`${item.source}-${index}`}>
          <select value={item.source} onChange={(event) => onChange(updateArray(value, index, { ...item, source: event.target.value }))}>
            <option value="status_code">状态码</option>
            <option value="json">JSON</option>
            <option value="body">响应正文</option>
            <option value="header">响应头</option>
          </select>
          <input value={item.path ?? ""} onChange={(event) => onChange(updateArray(value, index, { ...item, path: event.target.value }))} placeholder="路径，可选" />
          <select value={item.operator} onChange={(event) => onChange(updateArray(value, index, { ...item, operator: event.target.value }))}>
            {["==", "!=", ">", ">=", "<", "<=", "contains", "exists"].map((operator) => (
              <option key={operator}>{operator}</option>
            ))}
          </select>
          <input
            value={stringifyInput(item.expected)}
            onChange={(event) => onChange(updateArray(value, index, { ...item, expected: parseLiteral(event.target.value) }))}
            placeholder="期望值"
          />
          <button type="button" className="danger-link" onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}>
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      <button type="button" className="secondary-action" onClick={() => onChange([...value, { source: "status_code", operator: "==", expected: 200 }])}>
        <Plus size={15} />
        添加断言
      </button>
    </div>
  );
}

function normalizeSteps(rawSteps: unknown): Step[] {
  const items = Array.isArray(rawSteps) ? rawSteps : [];
  return items.map((item) => {
    const step = item as Partial<Step>;
    return {
      ...emptyStep(),
      ...step,
      type: step.type ?? "request",
      method: step.method ?? "GET",
      headers: step.headers ?? {},
      params: step.params ?? {},
      json: step.json ?? {},
      extract: step.extract ?? [],
      assertions: step.assertions ?? []
    };
  });
}

function parseJsonObject(text: string, label: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(text || "{}");
    if (data && typeof data === "object" && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
    window.alert(`${label} 必须是 JSON 对象`);
    return null;
  } catch {
    window.alert(`${label} JSON 格式不正确`);
    return null;
  }
}

function parseLiteral(raw: string): unknown {
  const value = raw.trim();
  if (!value) return "";
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (!Number.isNaN(Number(value)) && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("{") && value.endsWith("}")) || (value.startsWith("[") && value.endsWith("]"))) {
    try {
      return JSON.parse(value);
    } catch {
      return raw;
    }
  }
  return raw;
}

function stringifyInput(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function updateArray<T>(value: T[], index: number, nextItem: T): T[] {
  return value.map((item, itemIndex) => (itemIndex === index ? nextItem : item));
}

function PlansView({
  projects,
  environments,
  cases,
  plans,
  activeProjectId,
  createPlan,
  startRun,
  deletePlan
}: {
  projects: Project[];
  environments: Environment[];
  cases: TestCase[];
  plans: TestPlan[];
  activeProjectId?: number;
  createPlan: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  startRun: (plan: TestPlan) => Promise<void>;
  deletePlan: (id: number) => Promise<void>;
}) {
  const visibleCases = activeProjectId ? cases.filter((item) => item.project_id === activeProjectId) : cases;
  return (
    <div className="split">
      <section className="panel">
        <div className="section-title">
          <h2>计划配置</h2>
        </div>
        <form className="stack-form" onSubmit={createPlan}>
          <select name="project_id" defaultValue={activeProjectId}>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <select name="environment_id" defaultValue={environments.find((item) => item.project_id === activeProjectId)?.id}>
            {environments.map((environment) => (
              <option key={environment.id} value={environment.id}>
                {environment.name}
              </option>
            ))}
          </select>
          <input name="name" placeholder="计划名称" required />
          <input name="schedule" placeholder="计划节奏" />
          <input name="case_ids" placeholder="用例 ID，如 1,2" defaultValue={visibleCases.map((item) => item.id).join(",")} />
          <textarea name="description" placeholder="计划说明" rows={4} />
          <button className="primary-action">
            <GitBranch size={17} />
            保存计划
          </button>
        </form>
      </section>
      <section className="panel wide">
        <div className="asset-list">
          {plans.map((plan) => (
            <div className="asset-row plan-row" key={plan.id}>
              <GitBranch size={20} />
              <div>
                <strong>{plan.name}</strong>
                <span>{plan.description}</span>
              </div>
              <span className="pill">{plan.case_ids.length} cases</span>
              <button className="primary-action compact" onClick={() => startRun(plan)}>
                <Play size={16} />
                执行
              </button>
              <button className="danger-link" onClick={() => deletePlan(plan.id)}>
                <Trash2 size={15} />
                删除
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function RunsView({
  runs,
  selectedRun,
  setSelectedRun,
  reload
}: {
  runs: Run[];
  selectedRun: Run | null;
  setSelectedRun: (run: Run | null) => void;
  reload: () => Promise<void>;
}) {
  return (
    <div className="runs-layout">
      <section className="panel run-list-panel">
        <div className="section-title">
          <h2>执行记录</h2>
          <button className="secondary-action" onClick={() => reload()}>
            <RefreshCcw size={16} />
            刷新
          </button>
        </div>
        <RunTable runs={runs} onOpen={setSelectedRun} />
      </section>
      <section className="panel report-panel">
        {selectedRun ? <RunReport run={selectedRun} /> : <EmptyReport />}
      </section>
    </div>
  );
}

function RunTable({ runs, onOpen }: { runs: Run[]; onOpen: (run: Run) => void }) {
  return (
    <div className="table">
      <div className="table-head">
        <span>状态</span>
        <span>计划</span>
        <span>通过率</span>
        <span>耗时</span>
        <span>触发</span>
      </div>
      {runs.map((run) => (
        <button className="table-row" key={run.id} onClick={() => onOpen(run)}>
          <StatusBadge status={run.status} />
          <span>{run.plan_name ?? `Plan #${run.plan_id}`}</span>
          <span>{run.summary?.pass_rate ?? 0}%</span>
          <span>{formatMs(run.summary?.duration_ms)}</span>
          <span>{run.trigger_source}</span>
        </button>
      ))}
    </div>
  );
}

function RunReport({ run }: { run: Run }) {
  const cases = run.summary?.cases ?? [];
  const logs = run.logs ?? [];
  return (
    <>
      <div className="section-title">
        <div>
          <p className="eyebrow">Run #{run.id}</p>
          <h2>{run.plan_name ?? `计划 #${run.plan_id}`}</h2>
        </div>
        <StatusBadge status={run.status} />
      </div>
      <div className="report-summary">
        <Metric label="通过率" value={`${run.summary?.pass_rate ?? 0}%`} />
        <Metric label="用例数" value={run.summary?.total ?? 0} />
        <Metric label="通过" value={run.summary?.passed ?? 0} tone="ok" />
        <Metric label="失败" value={run.summary?.failed ?? 0} tone="danger" />
      </div>
      <div className="case-results">
        {cases.map((item) => (
          <div className="case-result" key={String(item.id)}>
            <StatusBadge status={String(item.status)} />
            <strong>{String(item.name)}</strong>
            <span>{formatMs(Number(item.duration_ms ?? 0))}</span>
          </div>
        ))}
      </div>
      <div className="log-stream">
        {logs.map((log, index) => (
          <details key={index} open={String(log.status) === "failed"}>
            <summary>
              <span className={classNames("dot", String(log.status))} />
              {String(log.step_name ?? log.message ?? "日志")}
              <small>{formatMs(Number(log.duration_ms ?? 0))}</small>
            </summary>
            <pre>{JSON.stringify(log, null, 2)}</pre>
          </details>
        ))}
      </div>
    </>
  );
}

function EmptyReport() {
  return (
    <div className="empty-state">
      <Activity size={36} />
      <h2>选择一条执行记录</h2>
    </div>
  );
}

function CaseList({ cases, onEdit, onDelete }: { cases: TestCase[]; onEdit: (item: TestCase) => void; onDelete: (id: number) => Promise<void> }) {
  return (
    <div className="asset-list">
      {cases.map((item) => (
        <div className="asset-row case-row" key={item.id}>
          <span className="priority">{item.priority}</span>
          <div>
            <strong>{item.name}</strong>
            <span>{item.description}</span>
          </div>
          <span className="pill">{item.steps.length} steps</span>
          <button className="secondary-action compact" onClick={() => onEdit(item)}>
            编辑
          </button>
          <button className="danger-link" onClick={() => onDelete(item.id)}>
            <Trash2 size={15} />
            删除
          </button>
        </div>
      ))}
    </div>
  );
}

function EnvironmentList({ environments }: { environments: Environment[] }) {
  return (
    <div className="env-grid">
      {environments.map((env) => (
        <div className="env-item" key={env.id}>
          <Settings2 size={18} />
          <strong>{env.name}</strong>
          <code>{env.base_url}</code>
          <span>{Object.keys(env.variables ?? {}).length} vars</span>
        </div>
      ))}
    </div>
  );
}

function DataTable<T extends { id: number }>({
  rows,
  columns,
  action
}: {
  rows: T[];
  columns: Array<[keyof T & string, string]>;
  action?: (row: T) => JSX.Element;
}) {
  return (
    <div className="simple-table">
      <div className="simple-head" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(120px,1fr)) 100px` }}>
        {columns.map(([, label]) => (
          <span key={label}>{label}</span>
        ))}
        {action && <span>操作</span>}
      </div>
      {rows.map((row) => (
        <div className="simple-row" key={row.id} style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(120px,1fr)) 100px` }}>
          {columns.map(([key]) => (
            <span key={key}>{String(row[key] ?? "")}</span>
          ))}
          {action?.(row)}
        </div>
      ))}
    </div>
  );
}

function Metric({ label, value, icon, tone }: { label: string; value: string | number; icon?: JSX.Element; tone?: "ok" | "danger" }) {
  return (
    <div className={classNames("metric", tone)}>
      {icon && <span className="metric-icon">{icon}</span>}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusBadge({ status }: { status?: string }) {
  const icon = status === "passed" ? <CheckCircle2 size={15} /> : status === "failed" ? <XCircle size={15} /> : status === "running" ? <Clock3 size={15} /> : <AlertTriangle size={15} />;
  return (
    <span className={classNames("status", status)}>
      {icon}
      {statusLabel(status)}
    </span>
  );
}

function pageTitle(view: View) {
  return {
    dashboard: "质量看板",
    projects: "项目与环境",
    apis: "接口资产",
    cases: "测试用例",
    plans: "测试计划",
    runs: "执行报告"
  }[view];
}

function matchProject(projectId: number, selected: number | "all") {
  return selected === "all" || projectId === selected;
}

function matchText(item: Record<string, unknown>, keyword: string) {
  if (!keyword.trim()) return true;
  return JSON.stringify(item).toLowerCase().includes(keyword.toLowerCase());
}
