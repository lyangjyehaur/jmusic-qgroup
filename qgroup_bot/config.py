"""Environment-only configuration. Secrets never enter argv or source control."""
import os
from pathlib import Path


def load_env_file(path):
    """Parse KEY=VALUE only, never execute. Existing environment wins."""
    try:
        with open(path, encoding='utf-8') as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, value = line.split('=', 1)
                key = key.strip()
                if key.startswith(('KANBAN_', 'QQBOT_')) and key not in os.environ:
                    os.environ[key] = value.strip().strip('"').strip("'")
    except (FileNotFoundError, OSError):
        pass


class Config:
    def __init__(self):
        path = os.environ.get('KANBAN_BOT_ENV', '')
        if path:
            load_env_file(path)
        self.app_id = os.environ.get('QQBOT_APP_ID', '').strip()
        self.app_secret = os.environ.get('QQBOT_APP_SECRET', '').strip()
        self.db = Path(os.environ.get('KANBAN_DB', '')).expanduser()
        self.group = os.environ.get('KANBAN_BOT_GROUP', '').strip()
        self.sandbox = os.environ.get('QQBOT_SANDBOX') == '1'
        # Deployment default. Shared bot_settings may explicitly override it;
        # selecting "inherit deployment settings" keeps this value in effect.
        self.dry_run = os.environ.get('KANBAN_BOT_DRY_RUN', '1') != '0'
        # Opt-in custom Markdown (msg_type=2) for passive replies AND active
        # outbox broadcasts. Default off: an existing deployment must not
        # change group messages silently. Real-device checks (2026-11-11)
        # confirmed the documented syntax and markdown+keyboard; QQ has no
        # escape mechanism, so user text keeps its own inline Markdown and
        # outbound links are guarded by allowed_link_hosts.
        self.markdown_replies = os.environ.get('KANBAN_BOT_MARKDOWN', '0') == '1'
        # 2026-08-10 changelog unified the OpenAPI host. The previously
        # verified host remains an explicit fallback until the new one is
        # confirmed from this deployment; see QQBotAPI.gateway().
        self.api_base = (os.environ.get('KANBAN_BOT_API_BASE', '').strip().rstrip('/')
                         or ('https://sandbox.api.sgroup.qq.com' if self.sandbox
                             else 'https://api.bot.qq.com'))
        self.legacy_api_base = 'https://api.sgroup.qq.com'
        # Explicit opt-in: an empty value keeps the existing behaviour, so a
        # deployment only enforces its URL allowlist once it is configured.
        raw_hosts = os.environ.get('KANBAN_BOT_ALLOWED_HOSTS', '').strip()
        self.allowed_link_hosts = tuple(
            host.strip().lower() for host in raw_hosts.split(',') if host.strip()) if raw_hosts else ()
        self.poll_interval = self._float('KANBAN_BOT_POLL_INTERVAL', 5.0, 1.0)
        self.max_attempts = self._int('KANBAN_BOT_MAX_ATTEMPTS', 5, 1)
        self.batch = self._int('KANBAN_BOT_BATCH', 10, 1)
        self.claim_timeout = self._int('KANBAN_BOT_CLAIM_TIMEOUT', 600, 30)
        self.setup_panels = os.environ.get('KANBAN_BOT_SETUP_PANELS', '0') == '1'
        self.intents = self._int('KANBAN_BOT_INTENTS', (1 << 25) | (1 << 26), 0)
        self.verbose_events = os.environ.get('KANBAN_BOT_VERBOSE', '0') == '1'
        self.log_dir = Path(os.environ.get('KANBAN_BOT_LOG_DIR') or self.db.parent / 'bot-logs').expanduser()
        self.log_content = os.environ.get('KANBAN_BOT_LOG_CONTENT', '0') == '1'
        self.log_content_limit = min(self._int('KANBAN_BOT_LOG_CONTENT_LIMIT', 500, 80), 2000)

    @staticmethod
    def _float(key, default, minimum):
        try:
            return max(float(os.environ.get(key, default)), minimum)
        except (TypeError, ValueError):
            return default

    @staticmethod
    def _int(key, default, minimum):
        try:
            return max(int(os.environ.get(key, default)), minimum)
        except (TypeError, ValueError):
            return default

    def validate(self):
        problems = []
        if not self.app_id or not self.app_secret:
            problems.append('QQBOT_APP_ID / QQBOT_APP_SECRET 未設定')
        if not str(self.db) or not self.db.is_file():
            problems.append('KANBAN_DB 必須指向與主服務相同的 SQLite 檔案')
        else:
            try:
                with self.db.open('rb') as handle:
                    if handle.read(16) != b'SQLite format 3\x00':
                        problems.append('KANBAN_DB 不是 SQLite 檔案')
            except OSError as exc:
                problems.append('KANBAN_DB 無法讀取：%s' % exc)
        if str(self.db) and self.db.is_file() and not os.access(self.db, os.W_OK):
            problems.append('KANBAN_DB 不可寫：bot 必須更新 bot_outbox 投遞狀態'
                            '（檢查 ProtectSystem / ReadWritePaths / 檔案擁有者）')
        return problems

    def describe(self):
        return ('db=%s group=%s… dry_run=%s api_host=%s poll=%.0fs batch=%d panels=%s sandbox=%s'
                % (self.db, self.group[:10], self.dry_run,
                   self.api_base.split('//')[-1], self.poll_interval,
                   self.batch, self.setup_panels, self.sandbox))
