// Generation-only Prisma config (Task 011, VPF-2). It has no datasource and
// loads no .env, so `prisma generate` never needs or sees a database URL.
// Migration commands use prisma7.config.ts, always with an explicit --config.
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
});
