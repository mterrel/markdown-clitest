import should from "should";
import { createShell, Shell } from "../src/shell";

const notFoundCode = 9009;

describe("Shell", () => {
    let shell: Shell;

    beforeEach(async () => {
        shell = await createShell();
    });

    afterEach(async () => {
        if (shell) shell.close();
    });

    it("should run multiple commands", async () => {
        let ret = await shell.command("echo HELLO");

        should(ret.stdout).equal("HELLO\n");
        should(ret.stderr).equal("");
        should(ret.all).equal("HELLO\n");
        should(ret.exitCode).equal(0);
        should(ret.cwd).equal(process.cwd());

        ret = await shell.command("echo HELLO2");
        should(ret.stdout).equal("HELLO2\n");
        should(ret.stderr).equal("");
        should(ret.all).equal("HELLO2\n");
        should(ret.exitCode).equal(0);
        should(ret.cwd).equal(process.cwd());
    });

    it("should capture stderr", async () => {
        const ret = await shell.command(`(echo HELLO) 1>&2`);

        should(ret.stdout).equal("");
        should(ret.stderr).equal("HELLO\n");
        should(ret.all).equal("HELLO\n");
        should(ret.exitCode).equal(0);
        should(ret.cwd).equal(process.cwd());
    });

    it("should error on bad command", async () => {
        try {
            await shell.command(`badcommand with args`);
            throw new Error("shell command should have thrown error");
        } catch (err) {
            should(err.message).equal(`Command 'badcommand with args' failed with exit code ${notFoundCode}`);
            should(err.stdout).equal("");
            should(err.exitCode).equal(notFoundCode);
            const errMsg = (process.platform === "win32") ?
                `'badcommand' is not recognized as an internal or external command,\n` +
                `operable program or batch file.\n` :
                `FIXME`;
            should(err.stderr).equal(errMsg);
            should(err.all).equal(errMsg);
            should(err.cwd).equal(process.cwd());
        }
    });

    it("should track cwd", async () => {
        const tmpdir = process.env.TEMP;
        const ret = await shell.command(`cd ${tmpdir}`);

        should(ret.stdout).equal("");
        should(ret.stderr).equal("");
        should(ret.all).equal("");
        should(ret.exitCode).equal(0);
        should(ret.cwd).equal(tmpdir);
    });
});
