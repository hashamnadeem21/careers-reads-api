import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Param, Patch, Res } from "@nestjs/common";
import { ApiProduces, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { z } from "zod";
import type { AuthUser } from "../auth/auth-user.js";
import { CurrentUser, StaffOnly } from "../auth/decorators.js";
import { ApiZodBody, ZodPipe } from "../common/zod.js";
import { MessagesService } from "./messages.service.js";

const idParam = new ZodPipe(z.coerce.number().int().positive("Not a valid id"));
const readSchema = z.object({ read: z.boolean() });
const removeSubscribersSchema = z.object({ ids: z.array(z.number().int().positive()).min(1).max(500) });

@ApiTags("messages")
@Controller("messages")
@StaffOnly()
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  /** Newest 200 messages, with `unread` and `subscribers` counts. */
  @Get()
  list() {
    return this.messages.listMessages();
  }

  /** Mark read or unread. */
  @Patch(":id")
  @ApiZodBody(readSchema)
  setRead(@Param("id", idParam) id: number, @Body(new ZodPipe(readSchema)) body: z.infer<typeof readSchema>) {
    return this.messages.setRead(id, body.read);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentUser() user: AuthUser, @Param("id", idParam) id: number): Promise<void> {
    await this.messages.removeMessage(user, id);
  }
}

@ApiTags("messages")
@Controller("subscribers")
@StaffOnly()
export class SubscribersController {
  constructor(private readonly messages: MessagesService) {}

  /** Newest 500 subscribers, with `unread` and `subscribers` counts. */
  @Get()
  list() {
    return this.messages.listSubscribers();
  }

  /** CSV download of every subscriber. Formula-like values are neutralised. */
  @Get("export.csv")
  @ApiProduces("text/csv")
  @Header("content-type", "text/csv; charset=utf-8")
  @Header("cache-control", "private, no-store")
  async export(@Res({ passthrough: true }) res: Response): Promise<string> {
    res.setHeader(
      "content-disposition",
      `attachment; filename="blognest-subscribers-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    return this.messages.subscribersCsv();
  }

  /** Remove subscribers by id. */
  @Delete()
  @HttpCode(HttpStatus.OK)
  @ApiZodBody(removeSubscribersSchema)
  remove(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(removeSubscribersSchema)) body: z.infer<typeof removeSubscribersSchema>,
  ) {
    return this.messages.removeSubscribers(user, body.ids);
  }
}
