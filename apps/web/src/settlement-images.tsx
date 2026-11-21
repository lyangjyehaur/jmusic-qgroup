import { errorText, uiText } from './language';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, Heading, Surface, Text } from 'yahha-ui';
import { SettlementAssetVersions, type Viewer } from '@qgroup/contracts';
import { z } from 'zod';
import { scopedHttp } from './http';
import { Failure, Notice, PageIntro, useSession } from './shared';
import { PaymentAssetImage } from './payment-image';
import { paymentKindLabels } from './payment-codes';

export function SettlementImagesPage() {
  const { id = '' } = useParams(), session = useSession();
  return <><PageIntro title="結算原圖" /><Link className="back" to={'/activities/' + encodeURIComponent(id) + '/finance'}>回到收付款帳本</Link>{session.error ? <Failure error={session.error} retry={() => void session.refetch()} /> : session.data ? <Versions key={session.data.scope + ':' + id} viewer={session.data} id={id} /> : <Notice>正在確認帳號…</Notice>}</>;
}
function Versions({ viewer, id }: { viewer: Viewer; id: string }) {
  const [search, setSearch] = useSearchParams();
  const versions = useQuery({ queryKey: ['private', viewer.scope, 'settlement-asset-versions', id], queryFn: () => scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/settlement/asset-versions', { params: { id } }), refetchOnWindowFocus: false });
  const [extra, setExtra] = useState<z.infer<typeof SettlementAssetVersions>['versions']>([]), [next, setNext] = useState<number | null | undefined>(), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const all = [...(versions.data?.versions ?? []), ...extra.filter(row => !versions.data?.versions.some(initial => initial.version === row.version))], cursor = next === undefined ? versions.data?.next_before : next;
  const requested = search.get('version'), version = requested ? Number(requested) : all[0]?.version;
  const valid = version !== undefined && Number.isSafeInteger(version) && version > 0;
  async function more() { if (!cursor || loading) return; setLoading(true); setError(''); try { const page = await scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/settlement/asset-versions', { params: { id }, query: {before:cursor} }); setExtra(rows => [...rows, ...page.versions.filter(row => !rows.some(old => old.version === row.version))]); setNext(page.next_before); } catch (failure) { setError(failure instanceof Error ? errorText(failure) : uiText("版本讀取失敗")); } finally { setLoading(false); } }
  if (versions.isPending) return <Notice>正在讀取結算版本…</Notice>;
  if (versions.error) return <Failure error={versions.error} retry={() => void versions.refetch()} />;
  if (!all.length) return <Notice>尚未發布結算，沒有可查看的原圖。</Notice>;
  return <><Surface className="detail"><Heading level={2}>結算版本</Heading><ul className="page-actions">{all.map(row => <li key={row.version}><Button variant="secondary" aria-pressed={version === row.version} onClick={() => setSearch({ version: String(row.version) })}>第 {row.version} 版 · ¥{(row.total_cents / 100).toFixed(2)} · {row.actor_name}</Button></li>)}</ul>{cursor && <Button loading={loading} variant="secondary" onClick={() => void more()}>載入較早版本</Button>}{error && <Text role="alert">{error}</Text>}</Surface>{valid ? <Images key={viewer.scope + ':' + id + ':' + version} viewer={viewer} id={id} version={version} /> : <Text role="alert">結算版本格式不正確，請重新選擇。</Text>}</>;
}
function Images({ viewer, id, version }: { viewer: Viewer; id: string; version: number }) {
  const assets = useQuery({ queryKey: ['private', viewer.scope, 'settlement-assets', id, version], queryFn: () => scopedHttp(viewer.scope).requestContract('GET /api/v2/activities/:id/settlement/history/:version/assets', { params: { id, version: String(version) } }) });
  if (assets.isPending) return <Notice>正在讀取第 {version} 版原圖…</Notice>;
  if (assets.error) return <Failure error={assets.error} retry={() => void assets.refetch()} />;
  return <><Heading level={2}>第 {version} 版原圖</Heading>{!assets.data.codes.length && !assets.data.receipts.length ? <Notice>本版未附收款碼或消費憑證。</Notice> : <div className="payment-library">{assets.data.codes.map(code => <Surface key={code.kind} className="detail"><Heading level={3}>{paymentKindLabels[code.kind]}收款碼{code.name ? ' · ' + code.name : ''}</Heading><PaymentAssetImage url={code.url} scope={viewer.scope} label={paymentKindLabels[code.kind] + '收款碼'} />{viewer.authenticated && assets.data.can_save && <Link to={'/me/payment-codes?' + new URLSearchParams({ event: id, version: String(version), kind: code.kind })}>保存到我的收款碼</Link>}</Surface>)}{assets.data.receipts.map(receipt => <Surface key={receipt.item_id} className="detail"><Heading level={3}>{receipt.name}</Heading><PaymentAssetImage url={receipt.url} scope={viewer.scope} label={'消費憑證 · ' + receipt.name} filename="receipt.png" /></Surface>)}</div>}</>;
}
