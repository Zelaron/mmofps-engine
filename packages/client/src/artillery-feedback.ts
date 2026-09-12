import { MAX_OWNED_ARTILLERY_SHELLS, TRAIN_NUCLEAR_CANNON } from '@shared/vehicles';

interface Point {x:number;y:number;z:number}
interface Shot extends Point {id:number;owner:number;weapon:number}
/** Keep only this player's small strategic salvo, including its last known
 * positions until impact events arrive after projectile retirement. */
export class ArtilleryFeedback {
  private readonly owned=new Map<number,{point:Point;seen:number}>();
  private reloadUntil=0;
  private detonation: {point:Point;until:number}|null=null;
  fired(now:number):void {this.reloadUntil=now+TRAIN_NUCLEAR_CANNON.interval;}
  get count():number {return this.owned.size;}
  reloadSeconds(now:number):number {return Math.max(0,this.reloadUntil-now);}
  sync(shots:readonly Shot[],owner:number,now:number):void {
    for(const shot of shots) {
      if(shot.weapon!==213||shot.owner!==owner)continue;
      if(!this.owned.has(shot.id)&&this.owned.size>=MAX_OWNED_ARTILLERY_SHELLS)this.owned.delete(this.owned.keys().next().value!);
      this.owned.set(shot.id,{point:{x:shot.x,y:shot.y,z:shot.z},seen:now});
    }
    for(const [id,shot] of this.owned)if(now-shot.seen>TRAIN_NUCLEAR_CANNON.fuse!+2)this.owned.delete(id);
  }
  impact(id:number,point:Point,now:number):boolean {
    if(!this.owned.delete(id))return false;
    this.detonation={point,until:now+8};return true;
  }
  marker(now:number):{point:Point;impact:boolean}|null {
    if(this.detonation&&now<this.detonation.until)return {point:this.detonation.point,impact:true};
    const newest=[...this.owned.values()].at(-1);
    return newest?{point:newest.point,impact:false}:null;
  }
  clear():void {this.owned.clear();this.detonation=null;this.reloadUntil=0;}
}
