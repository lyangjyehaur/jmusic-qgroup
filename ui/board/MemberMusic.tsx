import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  EmptyState,
  Heading,
  Link,
  Spinner,
  Text,
} from "yahha-ui";
import { errorMessage, errorStatus } from "../errors.ts";
import { ErrorMessage, useBoard } from "./primitives.tsx";
import type { MemberMusicProfile } from "./types.ts";

const levels: Record<number, string> = {
  4: "本命",
  3: "常听",
  2: "听过一些",
  1: "只听过几首",
};

export function MemberMusic({
  eventId,
  personId,
}: { eventId: string; personId: string }) {
  const app = useBoard();
  const [profile, setProfile] = useState<MemberMusicProfile | null>(null);
  const [error, setError] = useState("");
  const [login, setLogin] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setProfile(null);
    setError("");
    setLogin(false);
    app.api<MemberMusicProfile>(
      `/api/events/${eventId}/attendees/${personId}/music`,
    ).then(
      (value) => {
        if (active) setProfile(value);
      },
      (reason) => {
        if (active) {
          setError(errorMessage(reason));
          setLogin(errorStatus(reason) === 401);
        }
      },
    );
    return () => { active = false; };
  }, [app.api, app.me.draft_scope, app.me.authenticated, eventId, personId, attempt]);

  const ready = profile?.state === "ready" ? profile : null;
  const shared = ready?.picks.filter((pick) => pick.shared) || [];
  return (
    <div className="member-music">
      {error ? (
        <>
          <ErrorMessage error={error} />
          {login ? (
            <Link href="/music/">登录并连接成分站</Link>
          ) : (
            <Button variant="ghost" onClick={() => setAttempt((value) => value + 1)}>
              重试
            </Button>
          )}
        </>
      ) : !profile ? (
        <Spinner aria-label="读取成分" />
      ) : profile.state === "viewer_unlinked" ? (
        <EmptyState
          title="先连接你的成分"
          description="连接成分站后，就能查看群友的成分和共同选择。"
          action={<Link href="/music/">进入成分站</Link>}
        />
      ) : profile.state === "unlinked" ? (
        <EmptyState
          title="还没有关联成分"
          description="这份报名尚未关联成分站账号。"
        />
      ) : ready && (
        <>
          {!ready.is_self && (
            <section className="member-music-section">
              <Heading level={4}>共同选择 · {shared.length}</Heading>
              {shared.length ? (
                <div className="member-music-shared">
                  {shared.map((pick) => (
                    <Badge key={pick.id} tone="accent">{pick.text}</Badge>
                  ))}
                </div>
              ) : (
                <Text size="sm">目前还没有共同选择的项目。</Text>
              )}
            </section>
          )}
          {ready.picks.length ? (
            ["main", "sub"].map((kind) => {
              const picks = ready.picks
                .filter((pick) => pick.kind === kind)
                .sort((a, b) => b.level - a.level);
              return picks.length > 0 && (
                <section key={kind} className="member-music-section">
                  <Heading level={4}>
                    {kind === "main" ? "领域" : "歌手／作品"} · {picks.length}
                  </Heading>
                  <ul className="member-music-picks">
                    {picks.map((pick) => (
                      <li key={pick.id}>
                        <Text>{pick.text}</Text>
                        <Badge tone={pick.shared && !ready.is_self ? "accent" : "neutral"}>
                          {levels[pick.level]}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })
          ) : (
            <EmptyState title="还没有选择成分" />
          )}
        </>
      )}
    </div>
  );
}
