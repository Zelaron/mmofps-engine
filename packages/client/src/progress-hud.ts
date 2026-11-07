import { FACTIONS, type Faction, type FrontierState, type WarDebrief, type WarStatus } from '@shared/frontier';
import { XP_LABELS, XP_REASON, rankName, rankProgress, type DailyStatus, type XpEvent } from '@shared/progression';

export interface ProgressSounds { xp(big: boolean): void; promotion(): void; victory(won: boolean): void }

const RIBBON_LIMIT = 5;
const SHORT_NAMES = ['', 'Accord', 'Helix', 'Vanguard'] as const;
const RIBBON_MS = 2600;

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds)), m = Math.floor(s / 60), ss = String(s % 60).padStart(2, '0');
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function hours(seconds: number): string {
  const m = Math.max(1, Math.ceil(seconds / 60));
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

/** The intermission card: result, this soldier's war and its top soldier. */
export function debriefLines(debrief: WarDebrief): { title: string; result: string; stats: string; best: string } {
  const won = debrief.victor === debrief.faction;
  const kd = debrief.deaths ? (debrief.kills / debrief.deaths).toFixed(1) : String(debrief.kills);
  return {
    title: `WAR ${debrief.war} DEBRIEF`,
    result: won ? `Victory with ${FACTIONS[debrief.faction].name}` : `${FACTIONS[debrief.victor].name} won · ${FACTIONS[debrief.faction].name} fought on`,
    stats: `${debrief.kills} eliminations · ${debrief.deaths} deaths (K/D ${kd}) · ${debrief.captures} captures · +${debrief.xp.toLocaleString()} XP`,
    best: debrief.best ? (debrief.best.you ? `Top soldier of the war: you, with ${debrief.best.kills} eliminations`
      : `Top soldier: ${debrief.best.name} (${FACTIONS[debrief.best.faction].name}) · ${debrief.best.kills} eliminations`) : '',
  };
}

/** One compact line: how many of today's orders are done and the next one. */
export function dailyLine(daily: DailyStatus): { count: string; next: string } {
  const done = daily.orders.filter(order => order.done).length, next = daily.orders.find(order => !order.done);
  return { count: `DAILY ${done}/${daily.orders.length}`,
    next: next ? `${next.label} · ${next.progress}/${next.goal}` : `All done · new orders in ${hours(daily.resetsIn)}` };
}

/** Career progression and the state of the war, always visible and never
 * blocking play: experience ribbons beside the crosshair, a rank bar above
 * health, promotion and victory banners, and a compact war strip. */
export class ProgressHud {
  readonly ribbons = document.createElement('div');
  readonly rank = document.createElement('div');
  readonly war = document.createElement('div');
  readonly banner = document.createElement('div');
  readonly debriefCard = document.createElement('div');
  private debriefShown = 0;
  private xp = -1;
  private rankLevel = 0;
  private faction: Faction = 0;
  private warNumber = 0;
  private victorShown = 0;
  private pushActive = false;
  private latestWar: WarStatus | null = null;
  private warReceivedAt = 0;
  private bannerTimer: ReturnType<typeof setTimeout> | null = null;
  private session = 0;

  constructor(private readonly sounds: ProgressSounds, parent: HTMLElement = document.getElementById('hud') ?? document.body) {
    this.ribbons.id = 'xp-ribbons'; this.ribbons.setAttribute('aria-live', 'polite');
    this.rank.id = 'rank-panel'; this.rank.hidden = true;
    this.rank.innerHTML = '<div class="rank-line"><b class="rank-badge"></b><span class="rank-name"></span><span class="rank-session"></span></div><div class="rank-track"><div class="rank-fill"></div></div><div class="rank-xp"></div><div class="rank-daily" hidden><b></b><span></span></div>';
    this.war.id = 'war-strip'; this.war.hidden = true; this.war.setAttribute('aria-label', 'War status');
    this.banner.id = 'war-banner'; this.banner.hidden = true; this.banner.setAttribute('role', 'status');
    this.debriefCard.id = 'war-debrief'; this.debriefCard.hidden = true; this.debriefCard.setAttribute('role', 'status');
    parent.append(this.ribbons, this.rank, this.war, this.banner, this.debriefCard);
  }

  /** Immediate reward from the server. */
  xpEvent(event: XpEvent): void {
    const label = XP_LABELS[event.reason] ?? 'BONUS';
    const line = document.createElement('div');
    line.className = `xp-ribbon${event.amount >= 250 ? ' big' : ''}`;
    const amount = document.createElement('b'); amount.textContent = `+${event.amount}`;
    const text = document.createElement('span'); text.textContent = label;
    line.append(amount, text);
    this.ribbons.prepend(line);
    while (this.ribbons.children.length > RIBBON_LIMIT) this.ribbons.lastChild?.remove();
    setTimeout(() => { line.classList.add('fade'); setTimeout(() => line.remove(), 450); }, RIBBON_MS);
    this.session += event.amount;
    this.sounds.xp(event.amount >= 250);
    const promoted = this.rankLevel > 0 && event.rank > this.rankLevel;
    this.setXp(event.total);
    if (promoted) this.promote(event.rank);
    else if (event.reason === XP_REASON.DAILY) {
      this.showBanner('ORDER COMPLETE', `Daily order done · +${event.amount.toLocaleString()} XP`, 'promotion', 3200);
      this.sounds.promotion();
    }
  }

  private renderDaily(daily: DailyStatus | undefined): void {
    const row = this.rank.querySelector<HTMLElement>('.rank-daily')!;
    if (!daily?.orders.length) { row.hidden = true; return; }
    const { count, next } = dailyLine(daily);
    row.hidden = false;
    row.classList.toggle('complete', daily.orders.every(order => order.done));
    row.querySelector('b')!.textContent = count;
    row.querySelector('span')!.textContent = next;
  }

  private setXp(total: number): void {
    this.xp = total;
    const { rank, into, next } = rankProgress(total);
    this.rankLevel = rank;
    this.rank.hidden = false;
    this.rank.querySelector('.rank-badge')!.textContent = String(rank);
    this.rank.querySelector('.rank-name')!.textContent = rankName(rank).toUpperCase();
    this.rank.querySelector('.rank-session')!.textContent = this.session ? `+${this.session.toLocaleString()} this session` : '';
    (this.rank.querySelector('.rank-fill') as HTMLElement).style.width = `${next ? Math.min(100, into / next * 100) : 100}%`;
    this.rank.querySelector('.rank-xp')!.textContent = next ? `${into.toLocaleString()} / ${next.toLocaleString()} XP` : `${total.toLocaleString()} XP · MAX RANK`;
  }

  private promote(rank: number): void {
    this.showBanner(`PROMOTED`, rankName(rank).toUpperCase(), 'promotion', 3600);
    this.sounds.promotion();
  }

  private showBanner(title: string, detail: string, kind: string, ms: number): void {
    this.banner.hidden = false; this.banner.dataset.kind = kind;
    this.banner.innerHTML = '';
    const big = document.createElement('b'); big.textContent = title;
    const small = document.createElement('span'); small.textContent = detail;
    this.banner.append(big, small);
    if (this.bannerTimer) clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => { this.banner.hidden = true; this.bannerTimer = null; }, ms);
  }

  /** Strategic snapshot (1 Hz): rank totals and the war state. */
  receive(state: FrontierState): void {
    this.faction = state.you.faction;
    if (state.progress && state.progress.xp !== this.xp) this.setXp(state.progress.xp);
    if (state.progress) this.renderDaily(state.progress.daily);
    this.renderDebrief(state);
    if (!state.war) { this.war.hidden = true; return; }
    const war = state.war;
    this.latestWar = war; this.warReceivedAt = performance.now();
    if (this.warNumber && war.number > this.warNumber) {
      const home = state.bases?.find(b => b.owner === this.faction && b.kind === 'city')?.name;
      this.showBanner(`WAR ${war.number} BEGINS`, home ? `Your faction holds ${home}. Take ${war.victoryBases} bases to win.` : `Take ${war.victoryBases} bases to win.`, 'war', 6000);
    }
    this.warNumber = war.number;
    if (war.finalPush && !war.victor) {
      if (!this.pushActive) this.showBanner('FINAL PUSH', `The front has stalled. In ${clock(war.remaining)} the faction holding the most territory wins. Take a base to break the deadlock.`, 'push', 8000);
      this.pushActive = true;
    } else if (this.pushActive) {
      this.pushActive = false;
      if (!war.victor) this.showBanner('DEADLOCK BROKEN', 'A base changed hands. The war goes on.', 'war', 5000);
    }
    if (war.victor && this.victorShown !== war.number) {
      this.victorShown = war.number;
      const won = war.victor === this.faction;
      this.showBanner(won ? 'VICTORY' : 'DEFEAT', `${FACTIONS[war.victor].name} wins war ${war.number}. Next war in ${war.nextIn ?? 30} s.`, won ? 'victory' : 'defeat', 9000);
      this.sounds.victory(won);
    }
    this.renderWar();
  }

  /** Shown once per decided war, beside the action; never takes input. */
  private renderDebrief(state: FrontierState): void {
    const debrief = state.debrief;
    if (!debrief || !state.war?.victor) { this.debriefCard.hidden = true; return; }
    if (this.debriefShown === debrief.war) return;
    this.debriefShown = debrief.war;
    const lines = debriefLines(debrief);
    this.debriefCard.dataset.kind = debrief.victor === debrief.faction ? 'victory' : 'defeat';
    this.debriefCard.replaceChildren(...([['b', lines.title], ['strong', lines.result], ['span', lines.stats], ['em', lines.best]] as const)
      .filter(([, text]) => text).map(([tag, text]) => { const e = document.createElement(tag); e.textContent = text; return e; }));
    this.debriefCard.hidden = false;
  }

  private renderWar(): void {
    const war = this.latestWar; if (!war) return;
    const elapsed = (performance.now() - this.warReceivedAt) / 1000;
    this.war.hidden = false;
    const factions = ([1, 2, 3] as const).map(f => {
      const mine = f === this.faction ? ' mine' : '';
      const lead = war.bases[f] >= war.victoryBases - 1 ? ' near-win' : '';
      return `<span class="war-faction${mine}${lead}" style="--faction:${FACTIONS[f].color}"><i></i>${SHORT_NAMES[f]}<b>${war.bases[f]}</b></span>`;
    }).join('');
    const status = war.victor
      ? `<span class="war-clock">NEXT WAR ${clock((war.nextIn ?? 0) - elapsed)}</span>`
      : `<span class="war-clock${war.finalPush ? ' final' : ''}">${war.finalPush ? 'FINAL PUSH' : `WAR ${war.number}`} · ${clock(war.remaining - elapsed)}</span>`;
    this.war.innerHTML = `${status}${factions}<span class="war-goal">${war.victoryBases} BASES WIN</span>`;
  }

  /** The war clock ticks on its own timer; nothing per frame. */
  private readonly clockTimer = setInterval(() => { if (!this.war.hidden) this.renderWar(); }, 500);
  dispose(): void { clearInterval(this.clockTimer); this.ribbons.remove(); this.rank.remove(); this.war.remove(); this.banner.remove(); this.debriefCard.remove(); }

  /** Shown when a new war redeploys this soldier (instead of a death screen). */
  redeploy(): void {
    this.showBanner('REDEPLOYING', 'A new war begins. Homes have rotated — deploying to your faction\'s front.', 'war', 6000);
  }
}
