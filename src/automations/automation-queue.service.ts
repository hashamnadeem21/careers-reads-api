import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { InjectDb } from "../db/db.module.js";
import { automationDeliveries, emailAutomations } from "../db/schema.js";

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
}
