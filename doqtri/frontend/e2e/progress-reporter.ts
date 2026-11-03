import path from "node:path";
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestError,
  TestResult,
  TestStep,
} from "@playwright/test/reporter";

/**
 * A live view of an e2e run in the terminal (DOQ-16).
 *
 * - While the qdit stub and `next dev` start, a timer says so (Playwright
 *   starts web servers before the first test, and says nothing meanwhile).
 * - Each test prints a line when it starts and ✓ / ✘ / – with its time when
 *   it ends; a failure prints the first lines of its error.
 * - A status line at the bottom redraws every second: a progress bar, done
 *   out of total, passes and failures, total time, the running test with its
 *   own time, and the step it is on (a click, an expect, a test.step).
 * - The end prints a summary with every failure and how to open its trace.
 *
 * E2E_STEPS=1 also prints every finished step under its test. Without a
 * terminal (piped output, CI) there is no status line, only the lines.
 */

const TTY = Boolean(process.stdout.isTTY);
const COLOR = TTY && !process.env.NO_COLOR;
const PRINT_STEPS = process.env.E2E_STEPS === "1";
const LIST_MODE = process.argv.includes("--list");

const paint = (code: string) => (s: string) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = paint("32");
const red = paint("31");
const yellow = paint("33");
const cyan = paint("36");
const dim = paint("2");
const bold = paint("1");

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SHOWN_STEPS = new Set(["test.step", "pw:api", "expect", "hook"]);

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function seconds(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Visible width-aware cut, so the status line never wraps. */
function fit(s: string, width: number): string {
  const plain = stripAnsi(s);
  if (plain.length <= width) return s;
  return `${plain.slice(0, Math.max(0, width - 1))}…`;
}

export default class ProgressReporter implements Reporter {
  private started = Date.now();
  private total = 0;
  private done = 0;
  private passed = 0;
  private failed = 0;
  private skipped = 0;
  private flaky = 0;
  private failures: { test: TestCase; result: TestResult }[] = [];
  private running = new Map<TestCase, { start: number; step: string | null }>();
  private rootDir = process.cwd();
  private frame = 0;
  private timer: NodeJS.Timeout | null = null;
  private footerShown = false;
  private phase: "servers" | "tests" | "done" = "servers";

  constructor() {
    if (LIST_MODE) return;
    // Before onBegin: the web servers are starting.
    if (TTY) this.timer = setInterval(() => this.drawFooter(), 1000);
    this.timer?.unref();
    this.print(cyan("▶ starting the qdit stub and the dev server (the first compile can take a minute)…"));
  }

  printsToStdio(): boolean {
    return true;
  }

  onBegin(config: FullConfig, suite: Suite): void {
    if (LIST_MODE) {
      // `playwright test --list` hands its listing to the configured reporter.
      const tests = suite.allTests();
      for (const test of tests) {
        console.log(`  [${test.parent.project()?.name}] › ${path.relative(config.rootDir, test.location.file)}:${test.location.line} › ${test.titlePath().slice(3).join(" › ")}`);
      }
      const files = new Set(tests.map((t) => t.location.file)).size;
      console.log(`Total: ${tests.length} tests in ${files} files`);
      return;
    }
    this.rootDir = config.rootDir;
    this.total = suite.allTests().length;
    this.phase = "tests";
    const projects = [...new Set(suite.allTests().map((t) => t.parent.project()?.name).filter(Boolean))];
    this.print(
      `${bold(`Running ${this.total} test${this.total === 1 ? "" : "s"}`)} ${dim(
        `· ${config.workers} worker${config.workers === 1 ? "" : "s"} · projects: ${projects.join(", ")} · servers up after ${clock(Date.now() - this.started)}`,
      )}`,
    );
  }

  onTestBegin(test: TestCase, result: TestResult): void {
    this.running.set(test, { start: Date.now(), step: null });
    const retry = result.retry > 0 ? yellow(` (retry ${result.retry})`) : "";
    this.print(dim(`  ▶ [${this.done + 1}/${this.total}] ${this.title(test)}`) + retry);
  }

  onStepBegin(test: TestCase, _result: TestResult, step: TestStep): void {
    if (!this.shown(step)) return;
    const run = this.running.get(test);
    if (run) run.step = step.title;
  }

  onStepEnd(_test: TestCase, _result: TestResult, step: TestStep): void {
    if (!this.shown(step)) return;
    if (step.error) {
      this.print(`      ${red("✘")} ${step.title} ${dim(seconds(step.duration))}`);
    } else if (PRINT_STEPS) {
      this.print(dim(`      ✓ ${step.title} ${seconds(step.duration)}`));
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.running.delete(test);
    const time = dim(seconds(result.duration));
    const willRetry = result.status !== "passed" && result.status !== "skipped" && result.retry < test.retries;
    if (willRetry) {
      this.print(`  ${yellow("↻")} ${this.title(test)} ${time} ${yellow("failed, retrying")}`);
      return;
    }
    this.done++;
    const outcome = test.outcome();
    if (outcome === "skipped") {
      this.skipped++;
      this.print(`  ${yellow("–")} ${this.title(test)} ${dim("skipped")}`);
    } else if (outcome === "expected" || outcome === "flaky") {
      this.passed++;
      if (outcome === "flaky") this.flaky++;
      this.print(`  ${green("✓")} ${this.title(test)} ${time}${outcome === "flaky" ? yellow(" (flaky: passed on retry)") : ""}`);
    } else {
      this.failed++;
      this.failures.push({ test, result });
      this.print(`  ${red("✘")} ${this.title(test)} ${time}`);
      const message = this.errorText(result.errors[0] ?? result.error);
      if (message) this.print(message.split("\n").slice(0, 8).map((l) => red(`      ${l}`)).join("\n"));
    }
  }

  onStdOut(chunk: string | Buffer): void {
    this.passThrough(chunk);
  }

  onStdErr(chunk: string | Buffer): void {
    this.passThrough(chunk);
  }

  onError(error: TestError): void {
    this.print(red(`✘ ${this.errorText(error) || "error outside a test"}`));
  }

  onEnd(result: FullResult): void {
    if (LIST_MODE) return;
    this.phase = "done";
    if (this.timer) clearInterval(this.timer);
    this.clearFooter();
    const total = clock(Date.now() - this.started);
    const parts = [
      green(`${this.passed} passed`),
      this.failed ? red(`${this.failed} failed`) : null,
      this.skipped ? yellow(`${this.skipped} skipped`) : null,
      this.flaky ? yellow(`${this.flaky} flaky`) : null,
      this.done < this.total ? dim(`${this.total - this.done} did not run`) : null,
    ].filter(Boolean);
    console.log("");
    if (this.failures.length) {
      console.log(red(bold("Failed:")));
      for (const { test, result } of this.failures) {
        const loc = `${path.relative(this.rootDir, test.location.file)}:${test.location.line}`;
        console.log(`  ${red("✘")} ${this.title(test)} ${dim(loc)}`);
        const trace = result.attachments.find((a) => a.name === "trace")?.path;
        if (trace) console.log(dim(`      npx playwright show-trace ${path.relative(process.cwd(), trace)}`));
      }
      console.log("");
    }
    const verdict = result.status === "passed" ? green(bold("PASS")) : red(bold(result.status.toUpperCase()));
    console.log(`${verdict}  ${parts.join(dim(" · "))}  ${dim(`in ${total}`)}`);
  }

  // -------------------------------------------------------------------------

  private shown(step: TestStep): boolean {
    if (!SHOWN_STEPS.has(step.category)) return false;
    // Top-level steps, and those directly inside a test.step or hook; not the
    // internals of an expect's retries.
    return !step.parent || step.parent.category === "test.step" || step.parent.category === "hook";
  }

  private title(test: TestCase): string {
    const [, project, file, ...rest] = test.titlePath();
    return `${dim(`${project} › ${path.basename(file ?? "")} ›`)} ${rest.join(" › ")}`;
  }

  private errorText(error: TestError | undefined): string {
    if (!error) return "";
    return stripAnsi(error.message ?? error.value ?? "").trim();
  }

  private passThrough(chunk: string | Buffer): void {
    const text = chunk.toString().replace(/\n$/, "");
    if (text.trim()) this.print(dim(text));
  }

  /** Prints a line above the status line. */
  private print(line: string): void {
    this.clearFooter();
    console.log(line);
    this.drawFooter();
  }

  private clearFooter(): void {
    if (TTY && this.footerShown) {
      process.stdout.write("\r\x1b[2K");
      this.footerShown = false;
    }
  }

  private drawFooter(): void {
    if (!TTY || this.phase === "done") return;
    this.frame = (this.frame + 1) % SPINNER.length;
    const width = process.stdout.columns || 100;
    const elapsed = clock(Date.now() - this.started);
    let line: string;
    if (this.phase === "servers") {
      line = `${cyan(SPINNER[this.frame])} starting servers… ${dim(elapsed)}`;
    } else {
      const barWidth = 20;
      const filled = this.total ? Math.round((this.done / this.total) * barWidth) : 0;
      const bar = green("█".repeat(filled)) + dim("░".repeat(barWidth - filled));
      const counts = `${green(`✓${this.passed}`)} ${this.failed ? red(`✘${this.failed}`) : dim("✘0")}${this.skipped ? ` ${yellow(`–${this.skipped}`)}` : ""}`;
      const [test, run] = [...this.running.entries()][0] ?? [];
      const now = test && run
        ? ` ${cyan(SPINNER[this.frame])} ${test.title} ${dim(`${Math.floor((Date.now() - run.start) / 1000)}s`)}${run.step ? dim(` › ${run.step}`) : ""}`
        : "";
      line = `${bar} ${this.done}/${this.total} ${counts} ${dim(elapsed)}${now}`;
    }
    process.stdout.write(`\r\x1b[2K${fit(line, width - 1)}`);
    this.footerShown = true;
  }
}
