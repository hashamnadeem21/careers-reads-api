import {
  type BeforeApplicationShutdown,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { CronExpression, SchedulerRegistry } from "@nestjs/schedule";
import { CronJob } from "cron";
import { AutomationSender, type SendSummary } from "../automations/automation-sender.service.js";
import { env } from "../config/env.js";
import { NewslettersService } from "../newsletters/newsletters.service.js";

const JOB = "email-scheduler";

export interface RunSummary extends SendSummary {
  /** Scheduled newsletters started this run. */
  newsletters: number[];
}

/**
 * The email cron job. Every minute it starts scheduled newsletters whose time has come, then sends
 * automation emails that are due. A run that's still going when the next minute ticks is shared,
 * not doubled. Off when SCHEDULER_ENABLED=false (tests call `run()` themselves).
 */
@Injectable()
export class SchedulerService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger("Scheduler");
  private running: Promise<RunSummary> | null = null;

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly newsletters: NewslettersService,
    private readonly automations: AutomationSender,
  ) {}

  onApplicationBootstrap(): void {
    if (env().SCHEDULER_ENABLED !== "true") return;
    const job = CronJob.from({
      cronTime: CronExpression.EVERY_MINUTE,
      onTick: () => {
        this.run().catch((error: unknown) => {
          this.logger.error(`Run failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      },
      // Catch up straight away after a restart instead of waiting for the next minute.
      runOnInit: true,
    });
    this.registry.addCronJob(JOB, job);
    job.start();
    this.logger.log("Email scheduler started (every minute).");
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.registry.doesExist("cron", JOB)) await this.registry.getCronJob(JOB).stop();
    await this.running?.catch(() => undefined);
  }

  /** One pass. Calls while a pass is running get that pass's result. */
  run(now = new Date()): Promise<RunSummary> {
    this.running ??= this.pass(now).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async pass(now: Date): Promise<RunSummary> {
    const newsletters = await this.newsletters.startDue(now);
    const emails = await this.automations.sendDue(now);
    const summary = { newsletters, ...emails };
    if (newsletters.length) this.logger.log(`Started scheduled newsletter${newsletters.length === 1 ? "" : "s"} ${newsletters.join(", ")}.`);
    if (emails.sent || emails.failed || emails.retrying || emails.skipped) {
      this.logger.log(
        `Automation emails: ${emails.sent} sent, ${emails.retrying} to retry, ${emails.failed} failed, ${emails.skipped} skipped.`,
      );
    }
    return summary;
  }
}
