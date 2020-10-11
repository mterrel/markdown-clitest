import { InternalError } from "@adpt/utils";
import execa from "execa";
import pDefer from "p-defer";

export interface ShellOptions {
    cwd?: string;
}

export interface CommandOptions {
    output?: boolean;
}

export interface Output {
    stdout: string;
    stderr: string;
    all: string;
}

export interface CommandComplete extends Output {
    cwd: string;
    env: NodeJS.ProcessEnv;
    exitCode: number;
}

type ShellState = "init" | "idle" | "command" | "dumpEnv" | "exitCode" | "cwd" | "finish";

function emptyOutput(): Output {
    return {
        stdout: "",
        stderr: "",
        all: "",
    };
}

const prompt = "xxxCLITESTxxx";

const bashTrailer = `; printf "\\n${prompt}"`;

function initConfig() {
    if (process.platform === "win32") {
        return {
            shell: "cmd.exe",
            shellArgs: [],
            promptInit: `prompt ${prompt}`,
            printCwd: "cd\n",
            printExitCode: "echo %errorlevel%\n",
            printEnv: "set\n",
        };
    } else {
        return {
            shell: "bash",
            shellArgs: [],
            printCwd: `pwd${bashTrailer}\n`,
            printEnv: `env${bashTrailer}\n`,
        }
    }
}

const config = initConfig();

function processStream(s: NodeJS.ReadableStream, match: RegExp, handleMatch: (s: string) => void) {
    let buf = "";

    s.on("data", (chunk) => {
        buf += chunk.toString();
        while (buf.length) {
            const m = match.exec(buf)
            if (m == null) return;

            const line = m[0];

            buf = buf.slice(line.length);

            handleMatch(line);
        }
    });
    s.on("end", () => {
        if (buf.length > 0) handleMatch(buf);
    });
}

function chomp(s: string) {
    if (s.slice(-1) === "\n") {
        return s.slice(0, -1);
    }
    return s;
}

function parseEnv(output: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    const envLines = output.split("\n");
    for (const l of envLines) {
        if (/^\s*$/.test(l)) continue;
        const idx = l.indexOf("=");
        if (idx >= 0) {
            const name = l.slice(0, idx);
            const val = l.slice(idx + 1);
            env[name] = val;
        }
    }
    return env;
}

export class ShellError extends Error implements CommandComplete {
    all: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    exitCode: number;
    stdout: string;
    stderr: string;

    constructor(message: string, cmd: CommandComplete) {
        super(message);
        this.all = cmd.all;
        this.cwd = cmd.cwd;
        this.env = cmd.env;
        this.exitCode = cmd.exitCode;
        this.stdout = cmd.stdout;
        this.stderr = cmd.stderr;
    }
}

interface ShellStep {
    name: ShellState;
    start: () => Promise<void>;
    process: (out: Output) => Promise<void>;
}

process.on("SIGTTIN", () => {
    console.log("SIGTTIN")
});
process.on("SIGTTOU", () => {
    console.log("SIGTTOU")
});

export class Shell {
    _child?: execa.ExecaChildProcess<string>;
    exitError?: any;

    // Command state
    collecting: Output = emptyOutput();
    commandCwd?: string;
    commandEnv?: NodeJS.ProcessEnv;
    commandExitCode?: number;
    commandOptions?: CommandOptions;
    commandOutput?: Output;
    commandPromise?: pDefer.DeferredPromise<CommandComplete>;
    commandStep = 0;
    currentCommand?: string;

    async init(options: ShellOptions = {}) {
        const child = execa(config.shell, config.shellArgs, {
            stdio: "pipe",
            cwd: options.cwd,
        });
        this._child = child;

        child.catch((err) => {
            this.exitError = err;
        });

        processStream(child.stdout!, RegExp(`.*?\n|${prompt}`, "s"), this.onStdoutData);
        processStream(child.stderr!, RegExp(`.*?\\n`, "s"), this.onStderrData);

        if (config.promptInit) await this.command(config.promptInit);
    }

    get child() {
        if (!this._child) throw new InternalError(`Must call Shell.init before use`);
        return this._child;
    }

    get currentStep() {
        return this.commandSteps[this.commandStep];
    }

    get state() {
        return this.currentStep.name;
    }

    resetCommandState() {
        this.collecting = emptyOutput();
        delete this.commandEnv;
        delete this.commandExitCode;
        delete this.commandOptions;
        delete this.commandOutput;
        delete this.commandPromise;
        this.commandStep = 0;
        delete this.currentCommand;
    }

    async command(cmd: string, options: CommandOptions = {}) {
        if (cmd.includes("\n")) throw new InternalError(`Shell.command command cannot include '\\n'`);
        if (this.commandPromise) throw new InternalError(`Shell.command: a command was already in progress`);
        if (this.commandStep !== 0) throw new InternalError(`Shell.command: shell was not in idle state`);

        this.commandPromise = pDefer();
        this.currentCommand = cmd;
        this.commandOptions = options;

        this.commandStep++;
        await this.currentStep.start();

        return this.commandPromise.promise;
    }

    close() {
        this.child.stdin?.end();
    }

    onStdoutData = (line: string) => {
        line = line.toString().replace(/\r\n/g, "\n");

        console.log(`LINE[${line}]`)
        if (line === prompt) {
            this.foundPrompt().catch((err) => {
                this.rejectWithInternal(err);
            });
        } else {
            this.collecting.stdout += line;
            this.collecting.all += line;
            if (this.commandOptions?.output && this.state === "command") process.stdout.write(line);
        }
    }

    onStderrData = (line: string) => {
        line = line.toString().replace(/\r\n/g, "\n");
        this.collecting.stderr += line;
        this.collecting.all += line;
        if (this.commandOptions?.output && this.state === "command") process.stderr.write(line);
    }

    rejectWithInternal(err: InternalError) {
        const pResult = this.commandPromise;
        if (pResult == null) {
            // tslint:disable-next-line: no-console
            console.error("Internal error: commandPromise is null in rejectWithInternal");
            throw new InternalError("commandPromise is null in rejectWithInternal");
        }
        this.resetCommandState();
        pResult.reject(err);
    }

    async foundPrompt() {
        const out = this.collecting;
        console.log(out);
        this.collecting = emptyOutput();

        // Chomp the extra \n introduced by the prompt
        out.stdout = chomp(out.stdout);
        out.all = chomp(out.all);

        await this.currentStep.process(out);

        if (++this.commandStep >= this.commandSteps.length) {
            this.commandStep = 0;
            return;
        }

        await this.currentStep.start();
    }

    idleProcess = async () => {
        // tslint:disable-next-line: no-console
        console.error("Internal error: Shell received prompt in idle state");
        throw new InternalError("Shell received prompt in idle state");
    };

    commandStart = async () => {
        const cmd = this.currentCommand;
        if (!cmd) throw new InternalError("Shell has no currentCommand");
        this.child.stdin?.write(cmd + `; printf "\\n${prompt} $?\\n${prompt}"\n`);
    };
    commandProcess = async (out: Output) => {
        this.commandOutput = out;
    };

    exitCodeStart = async () => {
        if (config.printExitCode) this.child.stdin?.write(config.printExitCode);
    };
    exitCodeProcess = async (out: Output) => {
        const exitCode = parseInt(out.stdout, 10);
        if (isNaN(exitCode)) {
            throw new InternalError(`Could not parse exit code from '${out.stdout}'`);
        }
        this.commandExitCode = exitCode;
    };

    dumpEnvStart = async () => {
        this.child.stdin?.write(config.printEnv);
    };
    dumpEnvProcess = async (out: Output) => {
        this.commandEnv = parseEnv(out.stdout);
    };

    cwdStart = async () => {
        this.child.stdin?.write(config.printCwd);
    };
    cwdProcess = async (out: Output) => {
        this.commandCwd = chomp(out.stdout);
    };

    finishProcess = async () => {
        const pResult = this.commandPromise;
        if (pResult == null) {
            // tslint:disable-next-line: no-console
            console.error("Internal error: commandPromise is null");
            throw new InternalError("commandPromise is null");
        }


        const cmdOut = this.commandOutput;
        if (!cmdOut || cmdOut.stdout == null || cmdOut.stdout == null || cmdOut.all == null) {
            throw new InternalError("Shell: stdout, stderr, or all is null");
        }

        const cwd = this.commandCwd;
        if (cwd == null) {
            throw new InternalError("commandCwd is null");
        }

        const exitCode = this.commandExitCode;
        if (exitCode == null) {
            throw new InternalError("exitCode is null");
        }

        const env = this.commandEnv;
        if (env == null) {
            throw new InternalError("commandEnv is null");
        }

        const complete: CommandComplete = {
            all: cmdOut.all,
            cwd,
            env,
            exitCode,
            stdout: cmdOut.stdout,
            stderr: cmdOut.stderr,
        }

        const cmd = this.currentCommand;

        this.resetCommandState();

        if (exitCode === 0) {
            pResult.resolve(complete);
        } else {
            pResult.reject(new ShellError(`Command '${cmd}' failed with exit code ${exitCode}`,
                complete));
        }
    };

    commandSteps: ShellStep[] = [
        {
            name: "idle",
            start: async () => {/**/},
            process: this.idleProcess,
        },
        {
            name: "command",
            start: this.commandStart,
            process: this.commandProcess,
        },
        {
            name: "exitCode",
            start: this.exitCodeStart,
            process: this.exitCodeProcess,
        },
        {
            name: "dumpEnv",
            start: this.dumpEnvStart,
            process: this.dumpEnvProcess,
        },
        {
            name: "cwd",
            start: this.cwdStart,
            process: this.cwdProcess,
        },
        {
            name: "finish",
            start: this.finishProcess,
            process: async () => {/* */},
        },
    ]
}

export async function createShell(options: ShellOptions = {}) {
    const shell = new Shell();
    await shell.init(options);
    return shell;
}
