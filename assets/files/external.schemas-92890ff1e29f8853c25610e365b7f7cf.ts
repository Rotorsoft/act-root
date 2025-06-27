import { z } from "zod/v4";

export const SupportCategory = z.object({
  supportCategoryId: z.uuid(),
  name: z.string().min(3),
});

export const Product = z.object({
  productId: z.uuid(),
  tenantId: z.uuid(),
  name: z.string().min(5),
});

export const Tenant = z.object({
  tenantId: z.uuid(),
  name: z.string().min(3),
  email: z.email(),
  website: z.string().optional(),
  supportCategories: z.record(z.uuid(), SupportCategory),
});

export const User = z.object({
  userId: z.uuid(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.email(),
  isActive: z.boolean(),
  roleId: z.uuid(),
});

export const Role = z.object({
  roleId: z.uuid(),
  name: z.string().min(3),
});

export const Agent = User.and(
  z.object({
    tenantId: z.uuid(),
  })
);
