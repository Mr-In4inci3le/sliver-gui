export namespace main {
	
	export class AssemblyResult {
	    output: string;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new AssemblyResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.output = source["output"];
	        this.error = source["error"];
	    }
	}
	export class BeaconTaskResult {
	    taskId: string;
	    status: string;
	    stdout: string;
	    stderr: string;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new BeaconTaskResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.taskId = source["taskId"];
	        this.status = source["status"];
	        this.stdout = source["stdout"];
	        this.stderr = source["stderr"];
	        this.error = source["error"];
	    }
	}
	export class BeaconTaskView {
	    id: string;
	    state: string;
	    description: string;
	    createdAt: string;
	    completedAt: string;
	    response: string;
	
	    static createFrom(source: any = {}) {
	        return new BeaconTaskView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.state = source["state"];
	        this.description = source["description"];
	        this.createdAt = source["createdAt"];
	        this.completedAt = source["completedAt"];
	        this.response = source["response"];
	    }
	}
	export class BeaconView {
	    id: string;
	    name: string;
	    hostname: string;
	    username: string;
	    os: string;
	    arch: string;
	    transport: string;
	    remoteAddress: string;
	    pid: number;
	    interval: number;
	    jitter: number;
	    lastCheckin: string;
	    nextCheckin: string;
	    isDead: boolean;
	
	    static createFrom(source: any = {}) {
	        return new BeaconView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.hostname = source["hostname"];
	        this.username = source["username"];
	        this.os = source["os"];
	        this.arch = source["arch"];
	        this.transport = source["transport"];
	        this.remoteAddress = source["remoteAddress"];
	        this.pid = source["pid"];
	        this.interval = source["interval"];
	        this.jitter = source["jitter"];
	        this.lastCheckin = source["lastCheckin"];
	        this.nextCheckin = source["nextCheckin"];
	        this.isDead = source["isDead"];
	    }
	}
	export class BuildView {
	    name: string;
	    goos: string;
	    goarch: string;
	    format: string;
	    debug: boolean;
	    c2Urls: string[];
	
	    static createFrom(source: any = {}) {
	        return new BuildView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.goos = source["goos"];
	        this.goarch = source["goarch"];
	        this.format = source["format"];
	        this.debug = source["debug"];
	        this.c2Urls = source["c2Urls"];
	    }
	}
	export class C2ProfileView {
	    name: string;
	
	    static createFrom(source: any = {}) {
	        return new C2ProfileView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	    }
	}
	export class ConnectResult {
	    connected: boolean;
	    operatorName: string;
	    teamserver: string;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new ConnectResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.connected = source["connected"];
	        this.operatorName = source["operatorName"];
	        this.teamserver = source["teamserver"];
	        this.error = source["error"];
	    }
	}
	export class EnvVar {
	    key: string;
	    value: string;
	
	    static createFrom(source: any = {}) {
	        return new EnvVar(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.key = source["key"];
	        this.value = source["value"];
	    }
	}
	export class ExecResult {
	    stdout: string;
	    stderr: string;
	    status: number;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new ExecResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.stdout = source["stdout"];
	        this.stderr = source["stderr"];
	        this.status = source["status"];
	        this.error = source["error"];
	    }
	}
	export class FileInfo {
	    name: string;
	    isDir: boolean;
	    size: number;
	    mode: string;
	
	    static createFrom(source: any = {}) {
	        return new FileInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.isDir = source["isDir"];
	        this.size = source["size"];
	        this.mode = source["mode"];
	    }
	}
	export class GenerateRequest {
	    name: string;
	    goos: string;
	    goarch: string;
	    format: string;
	    c2Url: string;
	    debug: boolean;
	    beacon: boolean;
	    interval: number;
	    jitter: number;
	
	    static createFrom(source: any = {}) {
	        return new GenerateRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.goos = source["goos"];
	        this.goarch = source["goarch"];
	        this.format = source["format"];
	        this.c2Url = source["c2Url"];
	        this.debug = source["debug"];
	        this.beacon = source["beacon"];
	        this.interval = source["interval"];
	        this.jitter = source["jitter"];
	    }
	}
	export class GenerateResult {
	    file: string;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new GenerateResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.file = source["file"];
	        this.error = source["error"];
	    }
	}
	export class JobView {
	    id: number;
	    name: string;
	    protocol: string;
	    port: number;
	
	    static createFrom(source: any = {}) {
	        return new JobView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.protocol = source["protocol"];
	        this.port = source["port"];
	    }
	}
	export class LootView {
	    id: string;
	    name: string;
	    type: string;
	
	    static createFrom(source: any = {}) {
	        return new LootView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.type = source["type"];
	    }
	}
	export class LsResult {
	    path: string;
	    files: FileInfo[];
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new LsResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.files = this.convertValues(source["files"], FileInfo);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class NetInterfaceView {
	    name: string;
	    mac: string;
	    ips: string[];
	
	    static createFrom(source: any = {}) {
	        return new NetInterfaceView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.mac = source["mac"];
	        this.ips = source["ips"];
	    }
	}
	export class NetstatEntry {
	    localAddr: string;
	    remoteAddr: string;
	    protocol: string;
	    state: string;
	    pid: number;
	    process: string;
	
	    static createFrom(source: any = {}) {
	        return new NetstatEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.localAddr = source["localAddr"];
	        this.remoteAddr = source["remoteAddr"];
	        this.protocol = source["protocol"];
	        this.state = source["state"];
	        this.pid = source["pid"];
	        this.process = source["process"];
	    }
	}
	export class OperatorView {
	    name: string;
	    online: boolean;
	
	    static createFrom(source: any = {}) {
	        return new OperatorView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.online = source["online"];
	    }
	}
	export class PivotView {
	    id: string;
	    type: string;
	    bindAddress: string;
	
	    static createFrom(source: any = {}) {
	        return new PivotView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.type = source["type"];
	        this.bindAddress = source["bindAddress"];
	    }
	}
	export class PortForwardView {
	    localPort: number;
	    remote: string;
	
	    static createFrom(source: any = {}) {
	        return new PortForwardView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.localPort = source["localPort"];
	        this.remote = source["remote"];
	    }
	}
	export class PrivEntry {
	    name: string;
	    description: string;
	    enabled: boolean;
	
	    static createFrom(source: any = {}) {
	        return new PrivEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.description = source["description"];
	        this.enabled = source["enabled"];
	    }
	}
	export class PrivsResult {
	    integrity: string;
	    processName: string;
	    privs: PrivEntry[];
	
	    static createFrom(source: any = {}) {
	        return new PrivsResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.integrity = source["integrity"];
	        this.processName = source["processName"];
	        this.privs = this.convertValues(source["privs"], PrivEntry);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ProcessView {
	    pid: number;
	    ppid: number;
	    executable: string;
	    owner: string;
	    arch: string;
	    cmdLine: string;
	
	    static createFrom(source: any = {}) {
	        return new ProcessView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.pid = source["pid"];
	        this.ppid = source["ppid"];
	        this.executable = source["executable"];
	        this.owner = source["owner"];
	        this.arch = source["arch"];
	        this.cmdLine = source["cmdLine"];
	    }
	}
	export class ProfileView {
	    name: string;
	    goos: string;
	    goarch: string;
	    format: string;
	    c2Url: string;
	    debug: boolean;
	    beacon: boolean;
	    interval: number;
	    jitter: number;
	
	    static createFrom(source: any = {}) {
	        return new ProfileView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.goos = source["goos"];
	        this.goarch = source["goarch"];
	        this.format = source["format"];
	        this.c2Url = source["c2Url"];
	        this.debug = source["debug"];
	        this.beacon = source["beacon"];
	        this.interval = source["interval"];
	        this.jitter = source["jitter"];
	    }
	}
	export class RegistryValue {
	    name: string;
	    type: string;
	    value: string;
	
	    static createFrom(source: any = {}) {
	        return new RegistryValue(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.type = source["type"];
	        this.value = source["value"];
	    }
	}
	export class ServiceView {
	    name: string;
	    displayName: string;
	    status: string;
	
	    static createFrom(source: any = {}) {
	        return new ServiceView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.displayName = source["displayName"];
	        this.status = source["status"];
	    }
	}
	export class SessionView {
	    id: string;
	    name: string;
	    hostname: string;
	    username: string;
	    os: string;
	    arch: string;
	    transport: string;
	    remoteAddress: string;
	    lastCheckin: string;
	    pid: number;
	    isDead: boolean;
	
	    static createFrom(source: any = {}) {
	        return new SessionView(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.hostname = source["hostname"];
	        this.username = source["username"];
	        this.os = source["os"];
	        this.arch = source["arch"];
	        this.transport = source["transport"];
	        this.remoteAddress = source["remoteAddress"];
	        this.lastCheckin = source["lastCheckin"];
	        this.pid = source["pid"];
	        this.isDead = source["isDead"];
	    }
	}
	export class StartDNSReq {
	    domains: string[];
	
	    static createFrom(source: any = {}) {
	        return new StartDNSReq(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.domains = source["domains"];
	    }
	}
	export class StartHTTPReq {
	    host: string;
	    port: number;
	    secure: boolean;
	
	    static createFrom(source: any = {}) {
	        return new StartHTTPReq(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.host = source["host"];
	        this.port = source["port"];
	        this.secure = source["secure"];
	    }
	}
	export class StartMTLSReq {
	    host: string;
	    port: number;
	
	    static createFrom(source: any = {}) {
	        return new StartMTLSReq(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.host = source["host"];
	        this.port = source["port"];
	    }
	}
	export class StartWGReq {
	    port: number;
	    nPort: number;
	    keyPort: number;
	
	    static createFrom(source: any = {}) {
	        return new StartWGReq(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.port = source["port"];
	        this.nPort = source["nPort"];
	        this.keyPort = source["keyPort"];
	    }
	}
	export class TransferResult {
	    path: string;
	    bytes: number;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new TransferResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.bytes = source["bytes"];
	        this.error = source["error"];
	    }
	}
	export class VersionInfo {
	    major: number;
	    minor: number;
	    patch: number;
	    commit: string;
	    os: string;
	    arch: string;
	    compiled: string;
	
	    static createFrom(source: any = {}) {
	        return new VersionInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.major = source["major"];
	        this.minor = source["minor"];
	        this.patch = source["patch"];
	        this.commit = source["commit"];
	        this.os = source["os"];
	        this.arch = source["arch"];
	        this.compiled = source["compiled"];
	    }
	}

}

