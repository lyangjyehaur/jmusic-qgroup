import { Text } from 'yahha-ui';
import { Button, Select } from './kimi-ui';
import { useAppearance, presetLabels } from './appearance-preferences';

export function AppearanceControls({ quick = false }: { quick?: boolean }) {
  const prefs = useAppearance(), prefix = quick ? '快速' : '';
  return <div className="appearance-controls">
    <Select label={prefix+'主題色'} aria-label={quick ? '快速主題色' : '主題色'} value={prefs.value.preset} onChange={event => prefs.change({ preset: event.target.value as typeof prefs.value.preset })}>
      {Object.entries(presetLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </Select>
    <Select label={quick ? '快速明暗模式' : '主題'} aria-label={quick ? '快速明暗模式' : '主題'} value={prefs.value.theme} onChange={event => prefs.change({ theme: event.target.value as typeof prefs.value.theme })}>
      <option value="system">跟隨系統</option><option value="light">淺色</option><option value="dark">深色</option>
    </Select>
    <Select label={prefix+'資訊密度'} aria-label={quick ? '快速資訊密度' : '資訊密度'} value={prefs.value.density} onChange={event => prefs.change({ density: event.target.value as typeof prefs.value.density })}>
      <option value="comfortable">舒適</option><option value="compact">緊湊</option>
    </Select>
    <label className="switch-row appearance-wallpaper"><span><strong>{quick ? '快速顯示壁紙' : '顯示壁紙'}</strong></span><input type="checkbox" aria-label={quick ? '快速顯示壁紙' : '顯示壁紙'} checked={prefs.value.wallpapers} onChange={event => prefs.change({ wallpapers: event.target.checked })} /><i/></label>
    {prefs.error && <div role="alert"><Text>{prefs.error}</Text><Button onClick={prefs.retry}>重試保存偏好</Button><Button variant="secondary" onClick={prefs.repair}>保全原偏好後保存</Button></div>}
  </div>;
}
