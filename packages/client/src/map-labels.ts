export interface MapLabelCandidate {
  id: string; x: number; y: number; width: number; height: number; priority: number;
}
export interface MapLabelBox { x: number; y: number; width: number; height: number }
export interface MapLabelPlacement extends MapLabelBox { id: string; anchorX: number; anchorY: number }
const overlaps = (a: MapLabelBox, b: MapLabelBox, gap = 4) => a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;

/** A small deterministic screen-space label pass. Important reports get first
 * choice; lower-priority labels are omitted rather than forming a text wall.
 * Markers retain their exact world position and full accessible titles. */
export function placeMapLabels(candidates: readonly MapLabelCandidate[], bounds: MapLabelBox,
  obstacles: readonly MapLabelBox[] = [], limit = 14): MapLabelPlacement[] {
  const placed: MapLabelPlacement[] = [], occupied: MapLabelBox[] = [...obstacles];
  const sorted = [...candidates].sort((a,b)=>a.priority-b.priority||a.id.localeCompare(b.id));
  for(const label of sorted) {
    if(placed.length>=limit)break;
    if(label.x<bounds.x||label.y<bounds.y||label.x>bounds.x+bounds.width||label.y>bounds.y+bounds.height)continue;
    const w=label.width,h=label.height;
    const offsets=[[12,-h-5],[12,5],[-w-12,-h-5],[-w-12,5],[-w/2,-h-18],[-w/2,18],
      [17,-h-26],[17,26],[-w-17,-h-26],[-w-17,26]];
    // A contested control can sit among several vehicle and respawn glyphs.
    // Keep critical reports visible outside that cluster using a leader line.
    if(label.priority===0)for(const distance of [44,62])offsets.push(
      [-w/2,-h-distance],[-w/2,distance],[12,-h-distance],[12,distance],[-w-12,-h-distance],[-w-12,distance]);
    for(const [dx,dy] of offsets) {
      const box={x:label.x+dx,y:label.y+dy,width:w,height:h};
      if(box.x<bounds.x+5||box.y<bounds.y+5||box.x+w>bounds.x+bounds.width-5||box.y+h>bounds.y+bounds.height-5)continue;
      if(occupied.some(other=>overlaps(box,other)))continue;
      placed.push({...box,id:label.id,anchorX:label.x,anchorY:label.y});occupied.push(box);break;
    }
  }
  return placed;
}

export function shortControlName(name:string):string {
  return name.split(/\s[-–—·]\s/).at(-1)!.trim();
}
