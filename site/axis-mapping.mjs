// Teaching view of the production normalizedGeometric mapper.
// Ported from src/cpp/buv/SatoshiBlockheightToPixel.h; no chain data is simulated.
export const EPOCH_BLOCKS = 105000;
export const TIP = 966360;
export function epochWidth(epoch, current, width = 3720, ratio = 0.5) {
  if (epoch > current) return 0;
  if ((current + 1) * ratio <= 1 || epoch === current) return width * ratio;
  return width * (1-ratio) / (2*(1-0.5**current)) * 0.5**(current-epoch-1);
}
export function epochStart(epoch,current,width=3720) {
  if(epoch>current) return width;
  let x=0; for(let e=0;e<epoch;e++) x+=epochWidth(e,current,width); return x;
}
function rawX(block,current,width) {
  const epoch=Math.floor(block/EPOCH_BLOCKS);
  return Math.min(width-1,epochStart(epoch,current,width)+(block%EPOCH_BLOCKS)/EPOCH_BLOCKS*epochWidth(epoch,current,width));
}
export function blockX(block,currentBlock,width=3720) {
  const epoch=Math.floor(currentBlock/EPOCH_BLOCKS), offset=currentBlock%EPOCH_BLOCKS;
  if(epoch>0 && offset<120) {
    let t=(offset+1)/120; t=t*t*(3-2*t);
    const oldX=rawX(block,epoch-1,width),newX=rawX(block,epoch,width);
    return Math.floor(oldX+(newX-oldX)*t);
  }
  return Math.floor(rawX(block,epoch,width));
}
