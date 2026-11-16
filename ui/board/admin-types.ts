import type React from "react";
export interface AdminUser {
  id: string;
  nickname: string;
  is_admin: boolean;
  manual_qq: string;
  note: string;
  created_at: string;
  revision: number;
  metadata_revision: number;
  identities: {
    provider: string;
    display_name: string;
    unionid_bound: boolean;
  }[];
}
export interface UsersResult {
  users: AdminUser[];
  total: number;
  offset: number;
  limit: number;
}
export interface MusicMember {
  qq: string;
  name: string;
  user_id: string;
  board_name: string;
  board_active: boolean;
  contactQQ: string;
  has_pin: boolean;
  status: string;
  revision: number;
}
export interface MusicLinksResult {
  members: MusicMember[];
  history: {
    qq: string;
    before_user_id: string;
    after_user_id: string;
    actor_name: string;
    created: number;
  }[];
}
export interface BotGroup {
  id: string;
  name: string;
  replies: boolean;
  broadcast: boolean;
  last_seen?: string;
  membership?: string;
  reference?: string;
  deployment_default?: boolean;
  configured?: boolean;
  manual?: boolean;
}
export interface BotConfig {
  enabled: boolean;
  replies_enabled: boolean;
  dry_run: boolean | null;
  broadcast_kinds: string[];
  schedule_enabled: boolean;
  deadline_hours: number;
  estimated_over_delay_minutes: number;
  quiet_enabled: boolean;
  quiet_start: string;
  quiet_end: string;
  timezone: string;
  min_interval_seconds: number;
  templates: Record<string, string>;
  groups: BotGroup[];
}
export interface BotInfo {
  config: BotConfig;
  revision: number;
  runtime: { applied_revision: number | null; checked_at: string | null };
  group_status: {
    groups: BotGroup[];
    inherited: boolean;
    ignores: { group_id: string; created_at: string; reason: string }[];
  };
  kinds: Record<string, string>;
  variables: Record<string, string>;
  markdown_suffix: string;
  default_template: string;
  default_markdown_template: string;
  history: {
    revision: number;
    created_at: string;
    action: string;
    changes: string[];
  }[];
}
export interface PrivacyRequest {
  id: string;
  status: string;
  note: string;
  created_at: string;
  shared_records: Record<string, number>;
}
export interface AdminSettings {
  allow_name_registration: boolean;
  revision: number;
}
export interface AdminSession {
  csrf: string;
  auth_method: string;
  current_user_id: string;
  bot: BotInfo;
  settings: AdminSettings;
  providers: { enabled: boolean }[];
  privacy_requests: PrivacyRequest[];
}
export interface AdminApi {
  <T = void>(path: string, data?: unknown): Promise<T>;
}
export interface AdminContextValue {
  request: AdminApi;
  session: AdminSession | null;
  load(): Promise<void>;
  message: string;
  setMessage: React.Dispatch<React.SetStateAction<string>>;
  open(title: string, id: string, content: React.ReactNode): void;
  close(): void;
}
