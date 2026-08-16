import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string(),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  ACCESS_TOKEN_TTL: z.coerce.number().default(900),
  REFRESH_TOKEN_TTL: z.coerce.number().default(2_592_000),
  STRIPE_SECRET_KEY: z.string().optional(),
  /** Shared secret for internal service-to-service calls. */
  SERVICE_TOKEN: z.string().min(16).default("dev-service-token-change-me"),
  DATA_REGION: z.string().default("eu-central-1"),
  DPO_EMAIL: z.string().default("datenschutz@liefero.de"),
});

export const env = schema.parse(process.env);
export type Env = z.infer<typeof schema>;
