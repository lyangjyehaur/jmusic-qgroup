import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Button, Surface, Text } from 'yahha-ui';
import { Notice, PageIntro } from './shared';
type InstallPrompt = Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{
        outcome: 'accepted' | 'dismissed';
    }>;
};
const validBuild = (value: string | null | undefined) => !!value && /^[a-f0-9]{64}$/.test(value);
function usePWA() {
    const [supported] = useState(() => isSecureContext && 'serviceWorker' in navigator), [online, setOnline] = useState(navigator.onLine), [standalone, setStandalone] = useState(() => matchMedia('(display-mode: standalone)').matches || !!(navigator as Navigator & {
        standalone?: boolean;
    }).standalone);
    const [prompt, setPrompt] = useState<InstallPrompt | null>(null), [waiting, setWaiting] = useState<ServiceWorker | null>(null), [legacy, setLegacy] = useState(false), [ready, setReady] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
    const registration = useRef<ServiceWorkerRegistration | null>(null), active = useRef(true), pageBuild = document.querySelector<HTMLMetaElement>('meta[name="qgroup-build"]')?.content;
    const checks = useRef<(() => Promise<void>) | null>(null);
    useEffect(() => {
        active.current = true;
        let cancelled = false;
        const watched = new WeakSet<ServiceWorkerRegistration>();
        const disposers: (() => void)[] = [], seen = new WeakSet<ServiceWorker>();
        const media = matchMedia('(display-mode: standalone)'), installed = () => { setStandalone(true); setPrompt(null); }, offer = (event: Event) => { event.preventDefault(); setPrompt(event as InstallPrompt); }, connection = () => setOnline(navigator.onLine), display = () => setStandalone(media.matches || !!(navigator as Navigator & {
            standalone?: boolean;
        }).standalone);
        window.addEventListener('beforeinstallprompt', offer);
        window.addEventListener('appinstalled', installed);
        window.addEventListener('online', connection);
        window.addEventListener('offline', connection);
        media.addEventListener('change', display);
        function report() { if (supported && validBuild(pageBuild))
            navigator.serviceWorker.controller?.postMessage({ type: 'QGROUP_CLIENT_READY', build: pageBuild }); }
        function watchWorker(worker: ServiceWorker | null, changed: () => void, old: boolean) {
            if (!worker || seen.has(worker)) return;
            seen.add(worker);
            let installed = ['installed', 'activating', 'activated'].includes(worker.state);
            const state = () => {
                if (cancelled || !active.current) return;
                if (['installed', 'activating', 'activated'].includes(worker.state)) installed = true;
                if (!old && !installed && worker.state === 'redundant') {
                    setError('更新下載失敗，原版本仍保留。請稍後重試。');
                }
                changed();
            };
            worker.addEventListener('statechange', state);
            disposers.push(() => worker.removeEventListener('statechange', state));
        }
        function watch(reg: ServiceWorkerRegistration, old = false) {
            if (cancelled || watched.has(reg))
                return;
            watched.add(reg);
            const changed = () => {
                if (cancelled || !active.current) return;
                if (old) setLegacy(!!(reg.active || reg.waiting || reg.installing));
                else setWaiting(reg.waiting);
                watchWorker(reg.installing, changed, old);
                watchWorker(reg.waiting, changed, old);
            };
            reg.addEventListener('updatefound', changed);
            disposers.push(() => reg.removeEventListener('updatefound', changed));
            changed();
        }
        async function oldRegistrations() {
            let pending = false;
            for (const reg of await navigator.serviceWorker.getRegistrations()) {
                if (cancelled)
                    return;
                if (reg.scope !== location.origin + '/music/')
                    continue;
                const workers = [reg.active, reg.waiting, reg.installing].filter(Boolean) as ServiceWorker[];
                if (!workers.length || workers.some(worker => new URL(worker.scriptURL).origin !== location.origin || new URL(worker.scriptURL).pathname !== '/music/sw.js' || new URL(worker.scriptURL).search))
                    continue;
                pending = true;
                watch(reg, true);
                await reg.update();
            }
            if (!cancelled && active.current)
                setLegacy(pending);
        }
        async function check() {
            if (!supported)
                return;
            if (!validBuild(pageBuild))
                throw Error('目前頁面缺少建置版本，請重新載入後再檢查。');
            if (!registration.current) {
                const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
                if (cancelled || !active.current)
                    return;
                registration.current = reg;
                watch(reg);
            }
            else
                await registration.current.update();
            await oldRegistrations();
            report();
        }
        checks.current = check;
        const changed = () => { if (active.current)
            report(); }, reply = (event: MessageEvent) => {
            if (event.source !== navigator.serviceWorker.controller || event.data?.type !== 'QGROUP_WORKER_VERSION' || !validBuild(event.data.build))
                return;
            if (active.current)
                setReady(event.data.build !== pageBuild);
        };
        if (supported) {
            navigator.serviceWorker.addEventListener('controllerchange', changed);
            navigator.serviceWorker.addEventListener('message', reply);
            window.addEventListener('focus', changed);
            void check().catch(() => { if (!cancelled && active.current)
                setError('無法檢查離線元件；請恢復連線後重試。'); });
        }
        return () => { cancelled = true; active.current = false; checks.current = null; registration.current = null; for (const dispose of disposers)
            dispose(); window.removeEventListener('beforeinstallprompt', offer); window.removeEventListener('appinstalled', installed); window.removeEventListener('online', connection); window.removeEventListener('offline', connection); media.removeEventListener('change', display); if (supported) {
            navigator.serviceWorker.removeEventListener('controllerchange', changed);
            navigator.serviceWorker.removeEventListener('message', reply);
            window.removeEventListener('focus', changed);
        } };
    }, [supported, pageBuild]);
    async function check() { if (busy || !supported)
        return; setBusy(true); setError(''); setMessage(''); try {
        await checks.current?.();
        if (active.current)
            setMessage('已檢查更新；下載完成後會顯示可用版本。');
    }
    catch {
        if (active.current)
            setError('無法檢查離線元件；請恢復連線後重試。');
    }
    finally {
        if (active.current)
            setBusy(false);
    } }
    async function activate() {
        if (!waiting || busy)
            return;
        setBusy(true);
        setError('');
        const worker = waiting;
        try {
            const build = await new Promise<string>((resolve, reject) => {
                const channel = new MessageChannel(), timer = setTimeout(() => { channel.port1.close(); reject(Error('version timeout')); }, 3000);
                channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); if (validBuild(event.data?.build))
                    resolve(event.data.build);
                else
                    reject(Error('invalid version')); };
                worker.postMessage({ type: 'QGROUP_GET_VERSION' }, [channel.port2]);
            });
            if (active.current && worker.state === 'installed')
                worker.postMessage({ type: 'QGROUP_ACTIVATE', build });
        }
        catch {
            if (active.current)
                setError('無法啟用下載版本，請重新檢查更新。');
        }
        finally {
            if (active.current)
                setBusy(false);
        }
    }
    async function install() { if (!prompt || busy)
        return; setBusy(true); setMessage(''); try {
        await prompt.prompt();
        const result = await prompt.userChoice;
        if (active.current) {
            setPrompt(null);
            setMessage(result.outcome === 'accepted' ? '已送出安裝要求。' : '已取消安裝。');
        }
    }
    catch {
        if (active.current)
            setError('無法開啟安裝提示，請從瀏覽器選單加入主畫面。');
    }
    finally {
        if (active.current)
            setBusy(false);
    } }
    return { supported, online, standalone, prompt, waiting, legacy, ready, error, busy, message, check, activate, install };
}
type State = ReturnType<typeof usePWA>;
const Context = createContext<State | null>(null);
export function PWAProvider({ children }: {
    children: ReactNode;
}) { const state = usePWA(); return <Context.Provider value={state}>{children}</Context.Provider>; }
const useStateContext = () => { const state = useContext(Context); if (!state)
    throw Error('Missing PWA provider'); return state; };
export function PWAUpdateNotice() {
    const state = useStateContext();
    return <>
  {!state.online && <Notice>目前已離線；資料讀取與提交需要網路。未確認的操作請連線後明確核對。</Notice>}
  {(state.waiting || state.ready || state.legacy) && <Notice>{state.legacy ? '舊成分站離線元件待退役；請保存草稿，關閉舊成分站視窗後重新開啟。' : state.waiting ? '有新版可用；請先保存或保全草稿。' : '頁面與離線元件版本不同；保存草稿後可重新載入。'} <Link to="/me/app">檢查應用程式更新</Link></Notice>}
    </>;
}
export function AppSettingsPage() {
    const state = useStateContext();
    return <><PageIntro title="應用程式"/><Surface className="detail"><h2>安裝與更新</h2>
  {state.standalone ? <Text>目前以獨立視窗開啟。</Text> : state.prompt ? <Button loading={state.busy} onClick={() => void state.install()}>安裝群聚</Button> : <Text>可從瀏覽器選單選擇「安裝應用程式」或「加入主畫面」。</Text>}
  {!state.supported ? <Notice>此瀏覽器不支援離線元件，仍可連線使用網站。</Notice> : <Button loading={state.busy} onClick={() => void state.check()}>檢查更新</Button>}
  {state.waiting && <Button disabled={state.busy} onClick={() => void state.activate()}>啟用已下載版本</Button>}
  {(state.ready || state.legacy) && <Button variant="secondary" onClick={() => location.reload()}>保存草稿後重新載入</Button>}
  {state.error && <Text role="alert">{state.error}</Text>}{state.message && <Text role="status">{state.message}</Text>}
    </Surface></>;
}
