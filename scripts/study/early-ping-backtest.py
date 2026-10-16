#!/usr/bin/env python3
"""Early-ping vs current-ping backtest (study only). Daily option OHLC only -> see caveats."""
import json,gzip,glob,os,statistics as st,sys
from datetime import datetime,date
from zoneinfo import ZoneInfo
H='/workspace/flowguard/history'; ET=ZoneInfo('America/New_York')
days=sorted(os.path.basename(f)[:10] for f in glob.glob(H+'/flow/*.json.gz'))
TOP=5; _c={}
def chain(c):
    if c in _c: return _c[c]
    p=f'{H}/contracts/{c}.json.gz'; d=None
    if os.path.exists(p):
        d={x['date']:x for x in json.load(gzip.open(p)).get('chains',[])}
    _c[c]=d; return d
def et(s): return datetime.fromisoformat(s.replace('Z','+00:00')).astimezone(ET)
def cands(day,win):
    rows=json.load(gzip.open(f'{H}/flow/{day}.json.gz')); F=rows['fields']; out={}
    for r in rows['rows']:
        r=dict(zip(F,r)); t=et(r['created_at']); m=t.hour*60+t.minute
        if not(win[0]<=m<win[1]): continue
        try:
            prem=float(r['total_premium']); ask=float(r['total_ask_side_prem']); px=float(r['price'])
            a=float(r['ask'] or 0); b=float(r['bid'] or 0)
        except: continue
        dte=(date.fromisoformat(r['expiry'])-date.fromisoformat(day)).days
        if prem<200000 or px<0.2 or ask/prem<0.7 or not(5<=dte<=60): continue
        if float(r['volume_oi_ratio'] or 0)<1: continue
        if a>0 and b>0 and (a-b)/((a+b)/2)>0.10: continue          # 10% spread rule
        if r['type']=='put' and r['issue_type'] not in ('ETF','Index'): continue  # ETF/index-only puts
        k=r['option_chain']
        if k not in out or prem>out[k]['prem']: out[k]=dict(c=k,px=px,prem=prem,t=t)
    return sorted(out.values(),key=lambda x:-x['prem'])
def sim(c,i,entry,start_today=True):
    """+30 target / -25 stop / 2-session hold on daily H/L; same-bar both -> stop (conservative)."""
    ch=chain(c)
    for j in range(i,min(i+2,len(days))):
        b=ch.get(days[j])
        if not b or not b.get('high_price'): continue
        hi,lo=float(b['high_price']),float(b['low_price'])
        if lo<=entry*0.75: return -25.0
        if hi>=entry*1.30: return 30.0
    b=None
    for j in range(min(i+1,len(days)-1),i-1,-1):
        b=ch.get(days[j])
        if b and b.get('last_price'): break
    return (float(b['last_price'])/entry-1)*100 if b else None
def bar(c,d):
    ch=chain(c); b=ch.get(d) if ch else None
    return b if b and b.get('open_price') and b.get('low_price') else None
res={'a':[], 'b5':[], 'b10':[]}; cnt={k:dict(cand=0,nodata=0,skip=0) for k in res}
for i,d in enumerate(days[1:-1],1):
    # (a) current: first 30 min flow, ping ~10:00 ET; live ask proxy = max(print, day open, day VWAP-ish avg)
    for x in [y for y in cands(d,(570,600)) if chain(y['c']) is not None][:TOP]:
        cnt['a']['cand']+=1; b=bar(x['c'],d)
        if not b: cnt['a']['nodata']+=1; continue
        e=max(x['px'],float(b['open_price']),float(b.get('avg_price') or 0))
        if e>x['px']*1.10: cnt['a']['skip']+=1; continue
        r=sim(x['c'],i,e); res['a'].append((d,r)) if r is not None else None
    # (b) early: prior afternoon (>=13:00 ET D-1) + first 15 min of D
    pool=cands(days[i-1],(780,975))+cands(d,(570,585)); seen=set(); pl=[]
    for y in sorted(pool,key=lambda x:-x['prem']):
        if y['c'] in seen or chain(y['c']) is None: continue
        seen.add(y['c']); pl.append(y)
    for x in pl[:TOP]:
        b=bar(x['c'],d)
        for k,cap in (('b5',1.05),('b10',1.10)):
            cnt[k]['cand']+=1
            if not b: cnt[k]['nodata']+=1; continue
            mx=x['px']*cap; o,lo=float(b['open_price']),float(b['low_price'])
            if lo>mx: cnt[k]['skip']+=1; continue
            e=min(o,mx) if x['t'].date().isoformat()!=d else mx
            r=sim(x['c'],i,e); res[k].append((d,r)) if r is not None else None
out={}
for k,v in res.items():
    rs=[r for _,r in v]; byd={}
    for d,r in v: byd.setdefault(d,[]).append(r)
    c=cnt[k]; elig=c['cand']-c['nodata']
    out[k]=dict(candidates=c['cand'],no_data=c['nodata'],skipped=c['skip'],trades=len(rs),
      fill_rate=round(len(rs)/elig*100,1) if elig else None,
      win_pct=round(sum(r>0 for r in rs)/len(rs)*100,1) if rs else None,
      mean=round(st.mean(rs),1) if rs else None, median=round(st.median(rs),1) if rs else None,
      days_traded=len(byd), per_day_avg=round(st.mean(st.mean(x) for x in byd.values()),1) if byd else None,
      per_day_sum_avg=round(st.mean(sum(x) for x in byd.values()),1) if byd else None)
print(json.dumps(dict(sessions=len(days),first=days[0],last=days[-1],results=out),indent=1))
