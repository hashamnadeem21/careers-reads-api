import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { DEFAULT_WELCOME } from "../candidates/candidate-emails.js";
import { automationDeliveries, emailAutomations, settings } from "../db/schema.js";

/** Settings key recording that the default candidate welcome automation was created once. */
const CANDIDATE_WELCOME_SEEDED = "automations.candidateWelcomeSeeded";

/**
 * Turns events into queued automation emails. The scheduler sends them once they're due.
 * Each subscriber gets each automation at most once, however often the trigger happens.
 */
@Injectable()
export class AutomationQueue {
  constructor(@InjectDb() private readonly db: Database) {}

  /** Someone subscribed (or signed up again): queue every live "subscribed" automation for them. */
  async subscribed(subscriberId: number, now = new Date()): Promise<void> {
    const at = now.toISOString();
    await this.db.execute(sql`
      insert into ${automationDeliveries} (automation_id, subscriber_id, due_at)
      select ${emailAutomations.id}, ${subscriberId}, ${at}::timestamptz + make_interval(mins => ${emailAutomations.delayMinutes})
      from ${emailAutomations}
      where ${emailAutomations.active}
        and ${emailAutomations.trigger} = 'subscribed'
        and (${emailAutomations.startsAt} is null or ${emailAutomations.startsAt} <= ${at}::timestamptz)
        and (${emailAutomations.endsAt} is null or ${emailAutomations.endsAt} > ${at}::timestamptz)
      on conflict do nothing`);
  }

  /**
   * A candidate created their account: queue every live "candidate signs up" automation (the
   * welcome email). Returns how many were queued, so password sign-ups still get a confirmation
   * email when none is switched on.
   */
  async candidateSignedUp(candidateId: string, now = new Date()): Promise<number> {
    await this.ensureCandidateWelcome();
    const at = now.toISOString();
    const { rows } = await this.db.execute<{ id: number }>(sql`
      insert into ${automationDeliveries} (automation_id, candidate_id, due_at)
      select ${emailAutomations.id}, ${candidateId}::uuid, ${at}::timestamptz + make_interval(mins => ${emailAutomations.delayMinutes})
      from ${emailAutomations}
      where ${emailAutomations.active}
        and ${emailAutomations.trigger} = 'candidate_signed_up'
        and (${emailAutomations.startsAt} is null or ${emailAutomations.startsAt} <= ${at}::timestamptz)
        and (${emailAutomations.endsAt} is null or ${emailAutomations.endsAt} > ${at}::timestamptz)
      on conflict do nothing
      returning ${automationDeliveries.id}`);
    return rows.length;
  }

  /**
   * Creates the default welcome email (switched on) the very first time, so it works out of the box
   * and can be edited under Automations. Recorded in settings: deleting it later won't bring it back.
   */
  private async ensureCandidateWelcome(): Promise<void> {
    const [seeded] = await this.db.select({ key: settings.key }).from(settings).where(sql`${settings.key} = ${CANDIDATE_WELCOME_SEEDED}`).limit(1);
    if (seeded) return;
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${CANDIDATE_WELCOME_SEEDED}))`);
      const [again] = await tx.select({ key: settings.key }).from(settings).where(sql`${settings.key} = ${CANDIDATE_WELCOME_SEEDED}`).limit(1);
      if (again) return;
      await tx.insert(emailAutomations).values({ ...DEFAULT_WELCOME, trigger: "candidate_signed_up", delayMinutes: 0, active: true });
      await tx.insert(settings).values({ key: CANDIDATE_WELCOME_SEEDED, value: true });
    });
  }
}
