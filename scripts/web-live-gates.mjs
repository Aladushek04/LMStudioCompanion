export function acceptancePassed(readings, blocked) {
  return readings.length===10 && blocked.length===5 &&
    readings.every(r=>r.calls===1 && r.generated===true && r.markerMatched===true && ['ok','partial'].includes(r.status) && typeof r.sourceHash==='string' && /^[a-f0-9]{64}$/.test(r.sourceHash)) &&
    blocked.every(r=>r.calls===1 && r.generated===false && r.sourceStatus==='blocked');
}
