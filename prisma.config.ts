import "dotenv/config";
import { defineConfig } from "@prisma/config";

export default defineConfig({
  schema: "backend/prisma/schema.prisma",

  migrations: {
    path: "backend/prisma/migrations",
  },

  datasource: {
    // Use the direct (non-pooled) connection for Prisma CLI/migrations.
    // At runtime the app uses DATABASE_URL (pooled) via the pg adapter.
    url: process.env.DIRECT_URL!,
  },
});
