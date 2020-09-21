import should from "should";
import { runActions } from "../../src/actions";
import { CliTest, createCliTest } from "../../src/clitest";
import { readString } from "../testlib";

describe("command action", () => {
    let dt: CliTest | undefined;

    afterEach(async () => {
        if (dt) await dt.cleanup();
        dt = undefined;
    });

    it("should error on non-zero command exit", async () => {
        dt = await createCliTest({ filepath: "" });
        const md = [
            "Some text",
            "<!-- doctest command -->",
            "```",
            "echo foo && false",
            "```",
            "more text",
        ].join("\n");
        const actions = await readString(dt, md);
        // tslint:disable-next-line: no-trailing-whitespace
        await should(runActions(dt, actions)).be.rejectedWith(`Test failed: 

COMMAND FAILED: 'echo foo && false' (exit code 1)
Output:
foo
`);
    });

    it("should work correctly with comments in command", async () => {
        dt = await createCliTest({ filepath: "" });
        const md = [
            "Some text",
            "<!-- doctest command -->",
            "```",
            "echo 'Some output' # This is a comment",
            "```",
            '<!-- doctest output { matchRegex: "^Some output\\\\n$" } -->',
            "more text",
        ].join("\n");
        const actions = await readString(dt, md);
        await runActions(dt, actions);
    });
});
