import db from "debug";
import { CliTest, ConfirmAction } from "../clitest";
import { Action } from "./action";

const debugOutput = db("clitest:output");

export async function runCommand(dt: CliTest, cmd: string, _action: Action) {
    // Skip lines that are empty or only whitespace
    if (/^\s*$/.test(cmd)) return;

    dt.commands(`\nCWD: ${dt.cwd}`);
    dt.commands(`Command: ${cmd}`);
    const confirm = await dt.userConfirm("Continue?");
    if (confirm === ConfirmAction.skip) {
        dt.info(`SKIPPING: ${cmd}`);
        return;
    }

    try {
        const output = dt.interactive() || debugOutput.enabled;
        const ret = await dt.command(cmd, { output });
        dt.lastCommandOutput = ret.all;

        if (dt.interactive()) {
            await dt.userConfirm("Output OK?", { skipAllowed: false });
        }

    } catch (err) {
        if (!err.message) throw err;

        let msg = `\n\nCOMMAND FAILED: '${cmd}'`;
        if (err.all == null) {
            msg += `: ${err.message}`;
        } else {
            msg += ` (exit code ${err.exitCode})\nOutput:\n${err.all}`;
        }
        return dt.error(msg);
    }
}
