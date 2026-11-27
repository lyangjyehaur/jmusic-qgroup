import { SegmentedControl, Text } from 'yahha-ui';
import { AlignJustify, Check, Monitor, Moon, Rows3, Sun } from 'lucide-react';
import { Button, Switch } from './kimi-ui';
import { useAppearance, presetLabels } from './appearance-preferences';
import { uiText } from './language';
import './appearance-controls.css';

export function AppearanceControls({ quick = false }: { quick?: boolean }) {
  const prefs = useAppearance();
  return <div className="appearance-controls">
    <div className="appearance-choice"><span className="appearance-choice-label">主題色</span>
      <SegmentedControl label={quick ? '快速主題色' : '主題色'} aria-label={quick ? '快速主題色' : '主題色'} className="appearance-presets" classNames={{options:'appearance-preset-options',option:'appearance-option'}}
        value={prefs.value.preset} onValueChange={preset => prefs.change({preset})}
        options={(Object.keys(presetLabels) as (keyof typeof presetLabels)[]).map(value => ({value,label:<span className="appearance-color-choice"><span className="appearance-swatch" data-color={value} aria-hidden="true">{prefs.value.preset === value && <Check size={16}/>}</span><span>{presetLabels[value]}</span></span>}))}/>
    </div>
    <div className="appearance-choice"><span className="appearance-choice-label">明暗模式</span>
      <SegmentedControl label={quick ? '快速明暗模式' : '主題'} aria-label={quick ? '快速明暗模式' : '主題'} className="appearance-modes" classNames={{options:'appearance-mode-options',option:'appearance-option'}}
        value={prefs.value.theme} onValueChange={theme => prefs.change({theme})} options={[
          {value:'system',label:<span className="appearance-icon-choice"><Monitor size={18} aria-hidden="true"/><span>{uiText('跟隨系統')}</span></span>},
          {value:'light',label:<span className="appearance-icon-choice"><Sun size={18} aria-hidden="true"/><span>{uiText('淺色')}</span></span>},
          {value:'dark',label:<span className="appearance-icon-choice"><Moon size={18} aria-hidden="true"/><span>{uiText('深色')}</span></span>},
        ]}/>
    </div>
    <div className="appearance-choice"><span className="appearance-choice-label">資訊密度</span>
      <SegmentedControl label={quick ? '快速資訊密度' : '資訊密度'} aria-label={quick ? '快速資訊密度' : '資訊密度'} className="appearance-density" classNames={{options:'appearance-density-options',option:'appearance-option'}}
        value={prefs.value.density} onValueChange={density => prefs.change({density})} options={[
          {value:'comfortable',label:<span className="appearance-icon-choice"><Rows3 size={18} aria-hidden="true"/><span>{uiText('舒適')}</span></span>},
          {value:'compact',label:<span className="appearance-icon-choice"><AlignJustify size={18} aria-hidden="true"/><span>{uiText('緊湊')}</span></span>},
        ]}/>
    </div>
    <div className="appearance-wallpaper-setting"><Switch className="switch-row appearance-wallpaper" aria-label={quick ? '快速顯示壁紙' : '顯示壁紙'} checked={prefs.value.wallpapers} onChange={event => prefs.change({ wallpapers: event.target.checked })} label={<span>顯示壁紙</span>} />
      <p className="appearance-help">壁紙由管理員提供，全站共用。</p>
    </div>
    {prefs.error && <div role="alert"><Text>{prefs.error}</Text><Button onClick={prefs.retry}>重試保存偏好</Button><Button variant="secondary" onClick={prefs.repair}>保全原偏好後保存</Button></div>}
  </div>;
}
