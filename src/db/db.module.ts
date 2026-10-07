import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { env } from "../config/env.js";
import { connectDb, type Database, type DbConnection } from "./client.js";

const DB_CONNECTION = Symbol("DB_CONNECTION");
export const DB = Symbol("DB");

/** Injects the Drizzle client: `constructor(@InjectDb() private readonly db: Database) {}` */
export const InjectDb = () => Inject(DB);

@Global()
@Module({
  providers: [
    { provide: DB_CONNECTION, useFactory: (): DbConnection => connectDb(env().DATABASE_URL) },
    { provide: DB, inject: [DB_CONNECTION], useFactory: (connection: DbConnection): Database => connection.db },
  ],
  exports: [DB],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(DB_CONNECTION) private readonly connection: DbConnection) {}

  async onApplicationShutdown(): Promise<void> {
    await this.connection.end();
  }
}
