import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Priority } from "../schemas/index.js";

export const tickets = sqliteTable("tickets", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull(),
  supportCategoryId: text("support_category_id").notNull(),
  escalationId: text("escalation_id"),
  priority: text("priority").$type<Priority>().notNull(),
  title: text("title").notNull(),
  messages: integer("messages").notNull(),
  userId: text("user_id").notNull(),
  agentId: text("agent_id"),
  resolvedById: text("resolved_by_id"),
  closedById: text("closed_by_id"),
  reassignAfter: integer("reassign_after"),
  escalateAfter: integer("escalate_after"),
  closeAfter: integer("close_after"),
});
