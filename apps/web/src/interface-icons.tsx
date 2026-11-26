import { Bell, CalendarDays, CheckSquare, CircleUserRound, Clock3, Info, MapPin, Music2, Palette, Settings, UsersRound, WalletCards } from 'lucide-react';
const icons = { activities: CalendarDays, music: Music2, people: UsersRound, me: CircleUserRound, votes: CheckSquare, settings: Settings, palette: Palette, bell: Bell, clock: Clock3, location: MapPin, wallet: WalletCards, info: Info };
export function InterfaceIcon({ name, size = 19 }: { name: string; size?: number }) {
  const Icon = icons[name as keyof typeof icons];
  return Icon ? <Icon size={size} strokeWidth={1.8} aria-hidden="true"/> : null;
}
export function BrandMark() { return <span className="brand-mark" aria-hidden="true"><i/><i/><i/></span>; }
