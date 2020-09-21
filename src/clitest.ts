import { InternalError, UserError } from "@adpt/utils";
import chalk from "chalk";
import db from "debug";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { createInterface } from "readline";

import { CommandOptions, createShell, Shell } from "./shell";

const debugCommands = db("clitest:commands");
const debugOutput = db("clitest:output");
const debugParse = db("clitest:parse");

export interface Options {
    cleanup?: boolean;
    filepath: string;
    interactive?: boolean;
    list?: boolean;
}

export enum ConfirmAction {
    continue = "continue",
    skip = "skip",
}

// The supported chalk colors aren't available easily from the TS definitions
// for that package.
type ChalkColors = "red" | "green" | "white";

type WriteFunc = (s: string) => void;

const defaultOptions = {
    cleanup: true,
    filepath: "",
    interactive: false,
    list: false,
};

export interface UserConfirmOptions {
    color?: ChalkColors;
    skipAllowed?: boolean;
}

const defaultUserConfirmOptions = {
    color: "green" as const,
    skipAllowed: true,
};

export class CliTest {
    readonly options: Required<Options>;
    commands: WriteFunc = debugCommands;
    output: WriteFunc = debugOutput;
    parse: WriteFunc = debugParse;

    cmdEnv: NodeJS.ProcessEnv;
    cwd = "";
    file: string | undefined;
    lastCommandOutput: string | undefined;
    origPath: string;
    _shell?: Shell;
    tmpDir: string;

    constructor(options: Options) {
        this.options = { ...defaultOptions, ...options };
        this.origPath = process.env.PATH || "";
        this.interactive(options.interactive);
        this.updateEnv(process.env, "");
        if (!this.origPath) throw new Error(`Environment PATH is empty. Cannot continue.`);
    }

    async init() {
        if (this.tmpDir) return;
        this.tmpDir = await makeTmpdir();
        this.updateEnv(process.env, this.tmpDir);
        this._shell = await createShell({ cwd: this.cwd });
        this.output(`Running in temp dir: ${this.cwd}`);
    }

    private get shell() {
        if (!this._shell) throw new InternalError(`Must call init before use`);
        return this._shell;
    }

    info: WriteFunc = (s: string) => {
        // tslint:disable-next-line: no-console
        console.log(chalk.bold(s));
    }

    error(s: string): never {
        throw new UserError(`Test failed: ${s}`);
    }

    async cleanup() {
        this.shell.close();
        const tmpDir = this.tmpDir;
        if (this.options.cleanup) {
            this.output(`Removing temp dir: ${tmpDir}`);
            await fs.remove(tmpDir);
        } else {
            this.output(`NOT removing temp dir: ${tmpDir}`);
        }
    }

    interactive(on?: boolean) {
        const cur = this.options.interactive;
        if (on !== undefined) {
            this.commands = on ? this.info : debugCommands;
            this.output = on ? this.info : debugOutput;

            this.options.interactive = on;
        }
        return cur;
    }

    async userConfirm(query = "OK?", options: UserConfirmOptions = {}): Promise<ConfirmAction> {
        const opts = { ...defaultUserConfirmOptions, ...options };
        if (!this.interactive()) return ConfirmAction.continue;

        const rl = createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        const inputs = [ "Yes", "No" ];
        if (opts.skipAllowed) inputs.push("Skip");

        query = chalk[opts.color](query) + ` [${inputs.join(", ")}] `;
        try {
            while (true) {
                const ans = await new Promise<string>((resolve) => rl.question(query, resolve));

                switch (ans.toLowerCase()) {
                    case "":
                    case "y":
                    case "yes":
                        return ConfirmAction.continue;

                    case "n":
                    case "no":
                        throw new UserError("Canceled by user");

                    case "s":
                    case "skip":
                        if (opts.skipAllowed) return ConfirmAction.skip;
                        // Fall through

                    default:
                        this.info("Invalid response");
                        break;
                }
            }
        } finally {
            rl.close();
        }
    }

    async command(cmd: string, options: CommandOptions = {}) {
        try {
            const ret = await this.shell.command(cmd, options);
            this.updateEnv(ret.env, ret.cwd, true);
            return ret;
        } catch (err) {
            if (err.env && err.cwd) {
                this.updateEnv(err.env, err.cwd, true);
            }
            throw err;
        }
    }

    private updateEnv(newEnv: NodeJS.ProcessEnv, cwd: string, diff = false) {
        if (cwd !== this.cwd && diff) this.output(`Changed to new cwd: '${cwd}'`);
        this.cwd = cwd;

        const e = { ...newEnv };

        e.PATH = this.origPath;
        delete e.PWD;
        delete e._;
        delete e.SHLVL;
        delete e.OLDPWD;

        if (diff) {
            const lines = [];
            for (const key of Object.keys(e)) {
                if (key in this.cmdEnv) {
                    if (this.cmdEnv[key] === e[key]) continue;
                    lines.push(`- ${key}: ${this.cmdEnv[key]}`);
                    lines.push(`+ ${key}: ${e[key]}`);
                } else {
                    lines.push(`+ ${key}: ${e[key]}`);
                }
            }
            for (const key of Object.keys(this.cmdEnv)) {
                if (!(key in e)) {
                    lines.push(`- ${key}: ${this.cmdEnv[key]}`);
                }
            }
            if (lines.length > 0) {
                this.output(`Environment change:`);
                this.output(lines.join("\n") + "\n");
            }
        }

        this.cmdEnv = e;
    }
}

export async function createCliTest(options: Options) {
    const ct = new CliTest(options);
    await ct.init();
    return ct;
}

async function makeTmpdir() {
    return fs.mkdtemp(path.join(os.tmpdir(), "clitest-"));
}
