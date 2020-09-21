import db from "debug";
import { CliTest, ConfirmAction } from "../clitest";
import { ActionError } from "../error";
import { Action } from "./action";
import { checkOutput } from "./output";

const debugOutput = db("clitest:output");

export async function exec(dt: CliTest, action: Action, _lastOutput: string | undefined) {
    const cmd = action.params.cmd;
    let cmdStr: string;

    if (typeof cmd === "string" && cmd.length > 0) {
        cmdStr = cmd;

    } else if (Array.isArray(cmd)) {
        if (cmd.length === 0) {
            throw new ActionError(action, `Action 'exec' parameter 'cmd' array cannot be length 0`);
        }
        for (const c of cmd) {
            if (typeof c !== "string") {
                throw new ActionError(action, `Action 'exec' parameter 'cmd' has non-string element in array`);
            }
        }
        cmdStr = cmd.join(" ");

    } else {
        throw new ActionError(action, `Action 'exec' has invalid cmd parameter '${cmd}'. Must be string or array of string.`);
    }

    dt.commands(`\nCWD: ${dt.cwd}`);
    dt.commands(`Command: ${cmdStr}`);
    const confirm = await dt.userConfirm("Continue?");
    if (confirm === ConfirmAction.skip) {
        dt.info(`SKIPPING: ${cmdStr}`);
        return;
    }

    /* FIXME
    const env = {
        ...dt.cmdEnv,
        CLITEST_LAST_OUTPUT: lastOutput,
    };
    */
    const output = dt.interactive() || debugOutput.enabled;

    try {
        const ret = await dt.command(cmdStr, { output });

        if (action.params.matchRegex) {
            await checkOutput(dt, action, ret.all);
        }

    } catch (err) {
        const msg = `EXEC FAILED: ${cmdStr}\n${err.all || err.message}`;
        return dt.error(msg);
    }
}
