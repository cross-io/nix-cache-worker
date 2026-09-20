import type { Role } from "./middleware/auth";

export type Bindings = {
  CACHE_BUCKET: R2Bucket;
  DB: D1Database;
  READ_TOKEN?: string;
  WRITE_TOKEN?: string;
  ADMIN_TOKEN?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_S3_ENDPOINT?: string;
  R2_S3_ACCESS_KEY_ID?: string;
  R2_S3_SECRET_ACCESS_KEY?: string;
  DIRECT_UPLOAD_URL_TTL_SECONDS?: string;
  DIRECT_DOWNLOAD_URL_TTL_SECONDS?: string;
  DEFAULT_STORE_DIR?: string;
  DEFAULT_PRIORITY?: string;
  DEFAULT_WANT_MASS_QUERY?: string;
  DEFAULT_RETENTION_DAYS?: string;
  NIX_PUBLIC_SIGN_KEY?: string;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    requestId: string;
    role: Role;
  };
};

export type WorkerEnv = Bindings;
