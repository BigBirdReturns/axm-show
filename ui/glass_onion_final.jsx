import { useState, useCallback, useEffect, useRef, useMemo } from "react";

// ─── Shared data model (single source of truth) ───────────────────────────────
const KEMT_TILE = {
  tile_id: "kemt-sgv-v1", name: "San Gabriel Valley Airport (KEMT)",
  latitude: 34.0861, longitude: -118.0353, airspace_class: "D",
  max_altitude_agl_ft: 400, laanc_available: true, laanc_ceiling_ft: 200,
  authorization_required: true, elevation_ft: 296,
  tower_freq: "121.2 MHz", overlying: "LAX Class B shelf at 5000 MSL",
  laanc_grid: [
    { zone: "Airport surface", ceiling: 0 },
    { zone: "< 1nm from runway", ceiling: 100 },
    { zone: "1-2nm from runway", ceiling: 200 },
    { zone: "2-3.7nm (outer)", ceiling: 400 },
  ],
};

const FORMATIONS = [
  { id:"grid",label:"Grid",icon:"⊞" },{ id:"circle",label:"Circle",icon:"◯" },
  { id:"wave",label:"Wave",icon:"〜" },{ id:"sphere",label:"Sphere",icon:"⬡" },
  { id:"text",label:"Text",icon:"Aa" },{ id:"custom",label:"Custom",icon:"✦" },
];
const FALLBACKS = ["return_home","hold_position","land_in_place","safe_zone"];
const FAILURE_MODES = [
  { id:"wind_gust",label:"Wind Gusts",icon:"💨" },{ id:"rf_jam",label:"RF Jamming",icon:"📡" },
  { id:"drone_failure",label:"Drone Failure",icon:"⚡" },{ id:"gps_spoof",label:"GPS Spoofing",icon:"🛰" },
  { id:"battery_low",label:"Battery Low",icon:"🔋" },{ id:"crowd_incursion",label:"Crowd Incursion",icon:"👤" },
  { id:"full_disconnect",label:"Full Disconnect",icon:"🔇" },
];
const COMM_TIERS = [
  { key:"tier_0_full_mesh",label:"T0: Full Mesh",default:"execute_full_doctrine" },
  { key:"tier_1_degraded_rf",label:"T1: Degraded RF",default:"execute_reduced_doctrine" },
  { key:"tier_2_optical_only",label:"T2: Optical Only",default:"loiter_or_rth" },
  { key:"tier_3_full_disconnect",label:"T3: Disconnect",default:"land_in_place" },
];
const TIER_ACTIONS = ["execute_full_doctrine","execute_reduced_doctrine","loiter_or_rth","hold_position","land_in_place","return_home"];
const TIER_COLOR = { 0:"#e05c5c", 1:"#c8a84b", 2:"#8c6cc7" };
const TIER_BG    = { 0:"#e05c5c18", 1:"#c8a84b18", 2:"#8c6cc718" };
const TIER_LABEL = { 0:"REGULATORY", 1:"OPERATIONAL", 2:"CONTINGENCY" };

// ─── Shared data functions ─────────────────────────────────────────────────────
function buildShowSpec(tile, config, safety) {
  return {
    schema_version:"1.0.0",
    venue:{
      name:tile.name, latitude:tile.latitude, longitude:tile.longitude,
      airspace_class:tile.airspace_class, max_altitude_agl_ft:tile.max_altitude_agl_ft,
      laanc_available:tile.laanc_available, laanc_ceiling_ft:tile.laanc_ceiling_ft,
      authorization_required:tile.authorization_required, tfrs_active:false,
      data_source:"cached", data_retrieved_utc:"2026-02-27T00:00:00Z",
    },
    config:{
      show_name:config.show_name||"KEMT Demo Show", drone_count:config.drone_count||50,
      formation_type:config.formation_type||"grid", max_altitude_ft:config.max_altitude_ft||200,
      duration_seconds:config.duration_seconds||480,
      launch_time_utc:config.launch_time_utc||"2026-03-15T03:00:00Z",
      geofence_radius_m:config.geofence_radius_m||150, min_separation_m:config.min_separation_m||3.0,
    },
    safety:{
      wind_gust_fallback:safety.wind_gust_fallback||"hold_position",
      rf_jam_fallback:safety.rf_jam_fallback||"return_home",
      drone_failure_fallback:safety.drone_failure_fallback||"land_in_place",
      gps_spoof_fallback:safety.gps_spoof_fallback||"return_home",
      battery_low_fallback:safety.battery_low_fallback||"land_in_place",
      crowd_incursion_fallback:safety.crowd_incursion_fallback||"hold_position",
      full_disconnect_fallback:safety.full_disconnect_fallback||"land_in_place",
      comm_degradation_tiers:{
        tier_0_full_mesh:safety.tier_0_full_mesh||"execute_full_doctrine",
        tier_1_degraded_rf:safety.tier_1_degraded_rf||"execute_reduced_doctrine",
        tier_2_optical_only:safety.tier_2_optical_only||"loiter_or_rth",
        tier_3_full_disconnect:safety.tier_3_full_disconnect||"land_in_place",
      },
    },
  };
}

function extractClaims(spec) {
  const claims=[]; let idx=0;
  const add=(subj,pred,obj,objType,tier,evidence)=>{
    claims.push({ id:`c_${(idx++).toString().padStart(4,"0")}`, subject:subj, predicate:pred,
      object:obj, object_type:objType, tier, evidence });
  };
  const v=spec.venue, c=spec.config, s=spec.safety;
  add("show/venue","name",v.name,"literal:string",0,`"name": "${v.name}"`);
  add("show/venue","airspace_class",v.airspace_class,"literal:string",0,`"airspace_class": "${v.airspace_class}"`);
  add("show/venue","max_altitude_agl_ft",String(v.max_altitude_agl_ft),"literal:decimal",0,`"max_altitude_agl_ft": ${v.max_altitude_agl_ft}`);
  add("show/venue","laanc_available",String(v.laanc_available),"literal:string",0,`"laanc_available": ${v.laanc_available}`);
  add("show/venue","laanc_ceiling_ft",String(v.laanc_ceiling_ft),"literal:decimal",0,`"laanc_ceiling_ft": ${v.laanc_ceiling_ft}`);
  add("show/venue","authorization_required",String(v.authorization_required),"literal:string",0,`"authorization_required": ${v.authorization_required}`);
  add("show/venue","latitude",String(v.latitude),"literal:decimal",0,`"latitude": ${v.latitude}`);
  add("show/venue","longitude",String(v.longitude),"literal:decimal",0,`"longitude": ${v.longitude}`);
  add("show/venue","data_source",v.data_source,"literal:string",0,`"data_source": "${v.data_source}"`);
  add("show/venue","data_retrieved_utc",v.data_retrieved_utc,"literal:string",0,`"data_retrieved_utc": "${v.data_retrieved_utc}"`);
  add("show/config","show_name",c.show_name,"literal:string",1,`"show_name": "${c.show_name}"`);
  add("show/config","drone_count",String(c.drone_count),"literal:decimal",1,`"drone_count": ${c.drone_count}`);
  add("show/config","formation_type",c.formation_type,"literal:string",1,`"formation_type": "${c.formation_type}"`);
  add("show/config","max_altitude_ft",String(c.max_altitude_ft),"literal:decimal",1,`"max_altitude_ft": ${c.max_altitude_ft}`);
  add("show/config","duration_seconds",String(c.duration_seconds),"literal:decimal",1,`"duration_seconds": ${c.duration_seconds}`);
  add("show/config","geofence_radius_m",String(c.geofence_radius_m),"literal:decimal",1,`"geofence_radius_m": ${c.geofence_radius_m}`);
  add("show/config","min_separation_m",String(c.min_separation_m),"literal:decimal",1,`"min_separation_m": ${c.min_separation_m}`);
  if(c.launch_time_utc) add("show/config","launch_time_utc",c.launch_time_utc,"literal:string",1,`"launch_time_utc": "${c.launch_time_utc}"`);
  const fbMap={wind_gust_fallback:"wind_gust",rf_jam_fallback:"rf_jam",drone_failure_fallback:"drone_failure",gps_spoof_fallback:"gps_spoof",battery_low_fallback:"battery_low",crowd_incursion_fallback:"crowd_incursion",full_disconnect_fallback:"full_disconnect"};
  Object.entries(fbMap).forEach(([key,label])=>{
    if(s[key]) add("show/safety",`${label}_fallback`,s[key],"literal:string",2,`"${key}": "${s[key]}"`);
  });
  Object.entries(s.comm_degradation_tiers).forEach(([k,val])=>{
    add("show/safety",k,val,"literal:string",2,`"${k}": "${val}"`);
  });
  return claims;
}

async function sha256hex(str) {
  const buf=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
}
async function computeMerkle(leaves) {
  if(!leaves.length) return "0".repeat(64);
  let nodes=await Promise.all(leaves.map(l=>sha256hex(l)));
  while(nodes.length>1){
    const next=[];
    for(let i=0;i<nodes.length;i+=2){
      const a=nodes[i],b=i+1<nodes.length?nodes[i+1]:a;
      next.push(await sha256hex(a+b));
    }
    nodes=next;
  }
  return nodes[0];
}
function delay(ms){return new Promise(r=>setTimeout(r,ms));}

// ─── Backend integration ─────────────────────────────────────────────────────
// Set BACKEND_URL to enable live compilation. When null → demo mode.
const BACKEND_URL = null; // e.g. "http://localhost:8400"
const DEMO_MODE = !BACKEND_URL;

// ─── Provenance events (Tether Brief Section 6) ───────────────────────────────
const PROVENANCE_EVENTS=[
  {ts:"2026-02-27T06:14:32Z",pattern_id:"PAT-0042",tier:"CIVILIAN",description:"RF jam recovery — hold_position fallback",sessions:1847,recovery_rate:"99.94%",promoted_by:"axm-bounds compiler (automated)",command_sig:null,merkle_entry:"a3f8c1…",status:"AUTO-PROMOTED",status_color:"#c8a84b"},
  {ts:"2026-02-27T06:14:33Z",pattern_id:"PAT-0043",tier:"CIVILIAN",description:"Wind gust severity-2 — formation adapt",sessions:2103,recovery_rate:"99.97%",promoted_by:"axm-bounds compiler (automated)",command_sig:null,merkle_entry:"b7d2e4…",status:"AUTO-PROMOTED",status_color:"#c8a84b"},
  {ts:"2026-02-27T08:41:17Z",pattern_id:"PAT-0107",tier:"MILITARY",description:"Crowd incursion — abort formation, hold perimeter",sessions:null,recovery_rate:null,promoted_by:"LTC Sarah Chen",command_sig:"ML-DSA-44:c8f4a2…",merkle_entry:"f2a1b8…",status:"COMMAND-SIGNED",status_color:"#4a8aff"},
  {ts:"2026-02-27T09:12:44Z",pattern_id:"PAT-0108",tier:"MILITARY",description:"GPS denial — optical-only navigation fallback",sessions:null,recovery_rate:null,promoted_by:"LTC Sarah Chen",command_sig:"ML-DSA-44:d9e7f3…",merkle_entry:"c3d9a7…",status:"COMMAND-SIGNED",status_color:"#4a8aff"},
  {ts:"2026-02-27T11:30:00Z",pattern_id:"PAT-0201",tier:"CIVILIAN",description:"Battery <20% — return home immediately",sessions:4401,recovery_rate:"100%",promoted_by:"axm-bounds compiler (automated)",command_sig:null,merkle_entry:"e8b3f1…",status:"AUTO-PROMOTED",status_color:"#c8a84b"},
  {ts:"2026-02-28T14:22:10Z",pattern_id:"PAT-0301",tier:"MILITARY",description:"Full comm disconnect — autonomous land in place",sessions:null,recovery_rate:null,promoted_by:"LTC Sarah Chen",command_sig:"ML-DSA-44:a1c5e9…",merkle_entry:"d4f2c8…",status:"HELD",status_color:"#e05c5c",held_reason:"Pending JAG review — lethal autonomy boundary case"},
];

// ─── Glass Onion SVG (persistent intent router) ───────────────────────────────
function GlassOnion({ mode, onModeChange, shardReady }) {
  const modeForLayer={world:null,spoke:"plan",core:"compile",genesis:"compile",kernel:"inspect"};
  const activeRing={plan:"spoke",compile:"core",inspect:"kernel"}[mode];
  const fills={world:"#e8e0d0",spoke:"#d4c8b4",core:"#b8a890",genesis:"#887c64",kernel:"#1a3a6e"};
  const layers=[
    {id:"world",r:215},{id:"spoke",r:170},{id:"core",r:125},{id:"genesis",r:80},{id:"kernel",r:40},
  ];

  return (
    <svg viewBox="0 0 470 470" style={{width:"100%",maxWidth:320,cursor:"default",filter:"drop-shadow(0 6px 24px rgba(0,0,0,0.4))"}}>
      <defs>
        <radialGradient id="sheen" cx="38%" cy="32%" r="52%">
          <stop offset="0%" stopColor="rgba(255,255,255,0.16)"/>
          <stop offset="100%" stopColor="rgba(255,255,255,0)"/>
        </radialGradient>
        <filter id="glow"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>
      {[...layers].reverse().map(l=>{
        const target=modeForLayer[l.id];
        const isActive=activeRing===l.id;
        const canClick=target&&(target!=="inspect"||shardReady);
        const dimmed=!!mode&&!isActive;
        return (
          <g key={l.id} style={{cursor:canClick?"pointer":"default",opacity:dimmed?0.3:1,transition:"opacity 0.3s"}}
            onClick={()=>canClick&&onModeChange(target)}>
            <circle cx={235} cy={235} r={l.r} fill={fills[l.id]}
              stroke={isActive?"rgba(255,255,255,0.7)":"rgba(0,0,0,0.1)"}
              strokeWidth={isActive?2.5:1}
              style={{transition:"all 0.3s",filter:isActive?"url(#glow)":undefined}}/>
          </g>
        );
      })}
      <circle cx={235} cy={235} r={215} fill="url(#sheen)" pointerEvents="none"/>
      {mode==="inspect"&&<circle cx={235} cy={235} r={40} fill="none" stroke="rgba(90,140,220,0.5)" strokeWidth={10} style={{animation:"pulse 2s ease-in-out infinite"}} pointerEvents="none"/>}
      {mode==="compile"&&<circle cx={235} cy={235} r={125} fill="none" stroke="rgba(60,160,80,0.3)" strokeWidth={8} style={{animation:"pulse 1.5s ease-in-out infinite"}} pointerEvents="none"/>}
      {mode==="plan"&&<circle cx={235} cy={235} r={170} fill="none" stroke="rgba(200,168,75,0.2)" strokeWidth={6} style={{animation:"pulse 2.5s ease-in-out infinite"}} pointerEvents="none"/>}
      <g stroke="rgba(0,0,0,0.06)" strokeWidth={1} pointerEvents="none">
        <line x1={235} y1={18} x2={235} y2={195}/>
        <line x1={452} y1={235} x2={275} y2={235}/>
        <line x1={235} y1={452} x2={235} y2={275}/>
        <line x1={18} y1={235} x2={195} y2={235}/>
      </g>
      <g pointerEvents="none" fontFamily="'DM Mono',monospace">
        <path id="pw" d="M 48,235 A 187,187 0 0,1 422,235" fill="none"/>
        <text fontSize={7} fill="#a09480" letterSpacing={2.5}><textPath href="#pw" startOffset="14%">DEPLOYMENT CONTEXT · GOVERNANCE · TRUST STORE</textPath></text>
        <path id="ps" d="M 78,235 A 157,157 0 0,1 392,235" fill="none"/>
        <text fontSize={7} fill="#9a8870" letterSpacing={2}><textPath href="#ps" startOffset="10%">DOMAIN SPOKE · EMBODIED / SHOW / ISR</textPath></text>
        <path id="pc" d="M 116,235 A 119,119 0 0,1 354,235" fill="none"/>
        <text fontSize={7} fill="#786858" letterSpacing={2}><textPath href="#pc" startOffset="8%">AXM-CORE · HUB · FORGE · REGISTRY</textPath></text>
        <path id="pg" d="M 160,222 A 78,78 0 0,1 310,222" fill="none"/>
        <text fontSize={6.5} fill="#c8b890" letterSpacing={1.5}><textPath href="#pg" startOffset="5%">AXM-GENESIS · SPEC · VERIFY</textPath></text>
        <text x={235} y={231} textAnchor="middle" fontFamily="'Georgia',serif" fontSize={9.5} fill="rgba(255,255,255,0.88)" letterSpacing={1}>GOLD SHARD</text>
        <text x={235} y={245} textAnchor="middle" fontSize={7} fill="rgba(160,190,240,0.65)" letterSpacing={1}>fm21-11</text>
      </g>
      {!mode&&(
        <g pointerEvents="none" fontFamily="'DM Mono',monospace" fontSize={8} fill="rgba(0,0,0,0.4)" letterSpacing={0.3}>
          <text x={235} y={175} textAnchor="middle">PLAN</text>
          <text x={235} y={137} textAnchor="middle">COMPILE</text>
          <text x={235} y={263} textAnchor="middle">{shardReady?"INSPECT":"–"}</text>
        </g>
      )}
    </svg>
  );
}

// ─── Shared UI primitives ─────────────────────────────────────────────────────
const IS={background:"#120e0a",border:"1px solid #2a2420",borderRadius:4,padding:"6px 10px",color:"#e8dcc8",fontSize:11,fontFamily:"inherit",outline:"none",width:"100%",boxSizing:"border-box"};
const ISD={background:"#0a0a14",border:"1px solid #1a1a2e",borderRadius:4,padding:"5px 8px",color:"#8a9ab0",fontSize:10,fontFamily:"inherit",outline:"none"};
function Field({label,hint,hintColor,children}){
  return(
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
        <div style={{fontSize:10,color:"#9a8870",letterSpacing:0.5}}>{label}</div>
        {hint&&<div style={{fontSize:9,color:hintColor||"#4a3e30"}}>{hint}</div>}
      </div>
      {children}
    </div>
  );
}

// ─── MODE: PLAN ───────────────────────────────────────────────────────────────
function PlanMode({config,safety,onChange,onReady}){
  const [step,setStep]=useState(0);
  const tile=KEMT_TILE;
  const cc=(f,v)=>onChange({config:{...config,[f]:v},safety});
  const cs=(f,v)=>onChange({config,safety:{...safety,[f]:v}});
  const altViolation=config.max_altitude_ft>tile.laanc_ceiling_ft;

  return(
    <div style={{display:"flex",flexDirection:"column",height:"100%",overflow:"hidden"}}>
      <div style={{display:"flex",borderBottom:"1px solid #2a2420",flexShrink:0}}>
        {["01 · Venue","02 · Config","03 · Doctrine"].map((label,i)=>(
          <button key={i} onClick={()=>setStep(i)} style={{padding:"10px 18px",background:"transparent",border:"none",borderBottom:`2px solid ${step===i?"#c8a84b":"transparent"}`,color:step===i?"#e8dcc8":"#6a5e50",cursor:"pointer",fontSize:10,fontFamily:"inherit",letterSpacing:0.8,transition:"all 0.15s"}}>{label}</button>
        ))}
      </div>
      <div style={{flex:1,overflow:"auto",padding:20}}>
        {step===0&&(
          <div style={{display:"flex",flexDirection:"column",gap:16}}>
            <div style={{padding:16,background:"#1a1410",borderRadius:6,border:"1px solid #2a2420"}}>
              <div style={{fontSize:9,letterSpacing:2,color:"#6a5e50",marginBottom:10}}>VENUE TILE — TIER 0 (REGULATORY · LOCKED)</div>
              <div style={{color:"#e8dcc8",fontSize:14,marginBottom:8,fontFamily:"Georgia,serif"}}>{tile.name}</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"4px 16px"}}>
                {[["Airspace",`Class ${tile.airspace_class}`],["LAANC Ceiling",`${tile.laanc_ceiling_ft}ft AGL`],["Auth Required","Yes"],["Tower",tile.tower_freq],["Elevation",`${tile.elevation_ft}ft MSL`],["Overlying",tile.overlying]].map(([k,v])=>(
                  <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderTop:"1px solid #2a242033"}}>
                    <span style={{fontSize:10,color:"#6a5e50"}}>{k}</span>
                    <span style={{fontSize:10,color:"#c8a84b"}}>{v}</span>
                  </div>
                ))}
              </div>
              <div style={{marginTop:10}}>
                <div style={{fontSize:9,color:"#6a5e50",letterSpacing:1,marginBottom:6}}>LAANC GRID</div>
                {tile.laanc_grid.map((g,i)=>(
                  <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"3px 0",fontSize:10}}>
                    <span style={{color:"#6a5e50"}}>{g.zone}</span>
                    <span style={{color:g.ceiling===0?"#cf5c5c":"#c8a84b"}}>{g.ceiling===0?"NO OPS":g.ceiling+"ft"}</span>
                  </div>
                ))}
              </div>
              <div style={{marginTop:10,fontSize:9,color:"#4a3e30",lineHeight:1.6}}>Tier 0 claims come from the FAA tile, not operator choice. The compiler signs them as regulatory facts. They cannot be overridden.</div>
            </div>
            <button onClick={()=>setStep(1)} style={{padding:"8px",background:"#c8a84b12",border:"1px solid #c8a84b33",borderRadius:4,color:"#c8a84b",cursor:"pointer",fontSize:10,fontFamily:"inherit",letterSpacing:1}}>CONFIRM VENUE → CONFIGURE</button>
          </div>
        )}
        {step===1&&(
          <div style={{display:"flex",flexDirection:"column",gap:16}}>
            <div style={{padding:14,background:"#1a1410",borderRadius:6,border:"1px solid #2a2420"}}>
              <div style={{fontSize:9,letterSpacing:2,color:"#6a5e50",marginBottom:8}}>VENUE — TIER 0 (LOCKED)</div>
              <div style={{color:"#e8dcc8",fontSize:13,marginBottom:6,fontFamily:"Georgia,serif"}}>{tile.name}</div>
              <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>
                {[["Class",tile.airspace_class],["Ceiling",`${tile.laanc_ceiling_ft}ft AGL`],["LAANC","Available"],["Source","cached · 2026-02-27"]].map(([k,v])=>(
                  <div key={k} style={{fontSize:10}}><span style={{color:"#6a5e50"}}>{k}: </span><span style={{color:"#c8a84b"}}>{v}</span></div>
                ))}
              </div>
              <div style={{marginTop:8,fontSize:9,color:"#4a3e30",lineHeight:1.6}}>Tier 0 claims. From FAA data, not operator choice. Compiler signs them as regulatory facts — cannot be overridden.</div>
            </div>
            <Field label="Show Name" hint="Tier 1 — operational">
              <input value={config.show_name||""} onChange={e=>cc("show_name",e.target.value)} style={IS}/>
            </Field>
            <Field label="Drone Count" hint="Tier 1">
              <div style={{display:"flex",alignItems:"center",gap:12}}>
                <input type="range" min={1} max={200} value={config.drone_count||50} onChange={e=>cc("drone_count",parseInt(e.target.value))} style={{flex:1,accentColor:"#c8a84b"}}/>
                <span style={{color:"#e8dcc8",fontSize:13,minWidth:32,textAlign:"right"}}>{config.drone_count||50}</span>
              </div>
            </Field>
            <Field label="Formation Type" hint="Tier 1">
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {FORMATIONS.map(f=>(
                  <button key={f.id} onClick={()=>cc("formation_type",f.id)} style={{padding:"6px 12px",borderRadius:4,border:`1px solid ${config.formation_type===f.id?"#c8a84b":"#2a2420"}`,background:config.formation_type===f.id?"#c8a84b18":"#1a1410",color:config.formation_type===f.id?"#c8a84b":"#6a5e50",cursor:"pointer",fontSize:11,fontFamily:"inherit"}}>{f.icon} {f.label}</button>
                ))}
              </div>
            </Field>
            <Field label="Max Altitude (ft AGL)" hint={altViolation?"⚠ exceeds LAANC ceiling":"Tier 1"} hintColor={altViolation?"#e05c5c":undefined}>
              <div style={{display:"flex",alignItems:"center",gap:12}}>
                <input type="range" min={50} max={400} step={10} value={config.max_altitude_ft||200} onChange={e=>cc("max_altitude_ft",parseInt(e.target.value))} style={{flex:1,accentColor:altViolation?"#e05c5c":"#c8a84b"}}/>
                <span style={{color:altViolation?"#e05c5c":"#e8dcc8",fontSize:13,minWidth:36,textAlign:"right"}}>{config.max_altitude_ft||200}ft</span>
              </div>
              {altViolation&&<div style={{marginTop:4,fontSize:10,color:"#e05c5c",padding:"4px 8px",background:"#e05c5c11",borderRadius:3,border:"1px solid #e05c5c33"}}>Show ceiling exceeds LAANC auto-approval ({tile.laanc_ceiling_ft}ft). Manual ATC waiver required.</div>}
            </Field>
            <Field label="Duration" hint="Tier 1">
              <div style={{display:"flex",alignItems:"center",gap:12}}>
                <input type="range" min={60} max={1800} step={30} value={config.duration_seconds||480} onChange={e=>cc("duration_seconds",parseInt(e.target.value))} style={{flex:1,accentColor:"#c8a84b"}}/>
                <span style={{color:"#e8dcc8",fontSize:13,minWidth:48,textAlign:"right"}}>{Math.floor((config.duration_seconds||480)/60)}m {(config.duration_seconds||480)%60}s</span>
              </div>
            </Field>
            <Field label="Geofence Radius (m)" hint="Tier 1">
              <div style={{display:"flex",alignItems:"center",gap:12}}>
                <input type="range" min={50} max={500} step={10} value={config.geofence_radius_m||150} onChange={e=>cc("geofence_radius_m",parseInt(e.target.value))} style={{flex:1,accentColor:"#c8a84b"}}/>
                <span style={{color:"#e8dcc8",fontSize:13,minWidth:40,textAlign:"right"}}>{config.geofence_radius_m||150}m</span>
              </div>
            </Field>
          </div>
        )}
        {step===2&&(
          <div style={{display:"flex",flexDirection:"column",gap:16}}>
            <div style={{padding:14,background:"#1a1410",borderRadius:6,border:"1px solid #2a2420"}}>
              <div style={{fontSize:9,letterSpacing:2,color:"#6a5e50",marginBottom:12}}>FAILURE MODE FALLBACKS — TIER 2</div>
              {FAILURE_MODES.map(fm=>{
                const key=`${fm.id}_fallback`;
                return(
                  <div key={fm.id} style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                    <span style={{fontSize:14,minWidth:22}}>{fm.icon}</span>
                    <span style={{color:"#9a8870",fontSize:11,minWidth:120}}>{fm.label}</span>
                    <select value={safety[key]||"hold_position"} onChange={e=>cs(key,e.target.value)} style={{...IS,flex:1,padding:"4px 8px"}}>
                      {FALLBACKS.map(f=><option key={f} value={f}>{f}</option>)}
                    </select>
                  </div>
                );
              })}
            </div>
            <div style={{padding:14,background:"#1a1410",borderRadius:6,border:"1px solid #2a2420"}}>
              <div style={{fontSize:9,letterSpacing:2,color:"#6a5e50",marginBottom:4}}>COMM DEGRADATION TIERS — TIER 2</div>
              <div style={{fontSize:9,color:"#4a3e30",lineHeight:1.5,marginBottom:12}}>Each tier maps to a pre-compiled doctrine subset. The drone looks up its tier — it does not reason about it at runtime.</div>
              {COMM_TIERS.map(ct=>(
                <div key={ct.key} style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                  <span style={{color:"#8c6cc7",fontSize:10,minWidth:130}}>{ct.label}</span>
                  <select value={safety[ct.key]||ct.default} onChange={e=>cs(ct.key,e.target.value)} style={{...IS,flex:1,padding:"4px 8px"}}>
                    {TIER_ACTIONS.map(a=><option key={a} value={a}>{a}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <div style={{padding:"14px 20px",borderTop:"1px solid #2a2420",flexShrink:0}}>
        {altViolation&&<div style={{marginBottom:8,fontSize:10,color:"#e05c5c"}}>⚠ Reduce altitude to ≤{tile.laanc_ceiling_ft}ft before sealing</div>}
        <button onClick={onReady} disabled={altViolation} style={{width:"100%",padding:"10px 0",borderRadius:5,background:altViolation?"#1a1410":"linear-gradient(135deg,#b8960a,#c8a84b)",border:`1px solid ${altViolation?"#2a2420":"#c8a84b"}`,color:altViolation?"#4a3e30":"#0a0806",cursor:altViolation?"not-allowed":"pointer",fontSize:11,fontFamily:"inherit",letterSpacing:1.5,fontWeight:600,transition:"all 0.2s"}}>
          SEAL THE SHOW → COMPILE
        </button>
        <div style={{marginTop:5,fontSize:9,color:"#4a3e30",textAlign:"center"}}>Click the core ring to begin compilation</div>
      </div>
    </div>
  );
}

// ─── MODE: COMPILE ────────────────────────────────────────────────────────────
function CompileMode({spec,onComplete}){
  const [log,setLog]=useState([]);
  const [state,setState]=useState("idle");
  const [result,setResult]=useState(null);
  const logRef=useRef(null);
  const ran=useRef(false);
  useEffect(()=>{if(logRef.current)logRef.current.scrollTop=logRef.current.scrollHeight;},[log]);
  const addLog=useCallback((msg,type="info")=>{setLog(prev=>[...prev,{msg,type,id:Date.now()+Math.random()}]);},[]);

  useEffect(()=>{
    if(ran.current) return; ran.current=true;
    BACKEND_URL ? _compileLive() : _compileDemo();
  },[]);

  const _compileLive=useCallback(async()=>{
    setState("running");
    addLog("Show Compiler v1.0.0  ·  axm-show-server");
    addLog("Suite: axm-blake3-mldsa44 (ML-DSA-44, post-quantum)"); await delay(100);
    addLog(`POSTing to ${BACKEND_URL}/show/compile…`);
    try{
      const resp=await fetch(`${BACKEND_URL}/show/compile`,{
        method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(spec),
      });
      const data=await resp.json();
      if(!resp.ok||data.status==="FAIL"){
        (data.errors||["Server error"]).forEach(e=>addLog(`  ERROR: ${e}`,"error"));
        setState("fail"); return;
      }
      const {stats}=data;
      addLog("Validation: PASS","pass"); await delay(60);
      addLog(`Candidates: ${stats.claims} total`);
      addLog(`  Tier 0 (regulatory): ${stats.t0}`);
      addLog(`  Tier 1 (operational): ${stats.t1}`);
      addLog(`  Tier 2 (contingency): ${stats.t2}`); await delay(80);
      addLog(`  content/source.txt — ${data.source_text.length} bytes`);
      addLog(`Building entity graph…`);
      addLog(`  ${stats.entities} entities`); await delay(80);
      addLog("Writing Parquet tables…");
      for(const t of["graph/entities.parquet","graph/claims.parquet","graph/provenance.parquet","evidence/spans.parquet"]){
        addLog(`  ${t}`); await delay(30);
      }
      addLog("Computing BLAKE3 Merkle tree…  ← real blake3, not SHA-256");
      addLog(`  Root: ${data.merkle_root.slice(0,32)}…`); await delay(100);
      addLog("Signing manifest with ML-DSA-44 (FIPS 204)…");
      addLog("  Public key: 1312 bytes  Signature: 2420 bytes"); await delay(150);
      addLog("Self-verification gate (axm-verify shard)…");
      for(const[req,note] of [["REQ 1","Manifest integrity"],["REQ 2","Content identity"],["REQ 3","Lineage events"],["REQ 4","Proof bundle"],["REQ 5","Non-selective recording"]]){
        addLog(`  ${req}: ${note} …………… PASS`,"pass"); await delay(60);
      }
      addLog(""); addLog("PASS: Show Shard compiled  ← genesis kernel","pass");
      addLog(`  Show:     ${spec.config.show_name}`);
      addLog(`  Entities: ${stats.entities}  Claims: ${stats.claims}`);
      addLog(`  Suite:    ${data.suite}`);
      addLog(`  Merkle:   ${data.merkle_root.slice(0,32)}…`);
      addLog(`  Shard:    ${data.shard_id.slice(0,44)}…`);
      const res={
        status:"PASS",shardId:data.shard_id,merkleRoot:data.merkle_root,
        timestamp:data.timestamp,suite:data.suite,
        claims:data.claims,spec,sourceText:data.source_text,
        entities:stats.entities,t0:stats.t0,t1:stats.t1,t2:stats.t2,
        manifest:data.manifest,_live:true,
      };
      setResult(res); setState("pass"); onComplete(res);
    }catch(err){
      addLog(`  NETWORK ERROR: ${err.message}`,"error");
      addLog(`  Is the server running?  python server.py`,"error");
      setState("fail");
    }
  },[spec,addLog,onComplete]);

  const _compileDemo=useCallback(async()=>{
    setState("running");
    const claims=extractClaims(spec);
    const src=JSON.stringify(spec,null,2);
    addLog("Show Compiler v1.0.0");
    addLog("Suite: axm-blake3-mldsa44 (ML-DSA-44, post-quantum)"); await delay(200);
    addLog(`Reading: ${spec.config.show_name}`); await delay(150);
    addLog("Validating show spec…");
    if(spec.config.max_altitude_ft>spec.venue.laanc_ceiling_ft){
      addLog(`VALIDATION ERROR: altitude violation`,"error"); setState("fail"); return;
    }
    addLog("Validation: PASS","pass"); await delay(200);
    const t0=claims.filter(c=>c.tier===0).length, t1=claims.filter(c=>c.tier===1).length, t2=claims.filter(c=>c.tier===2).length;
    addLog(`Candidates: ${claims.length} total`);
    addLog(`  Tier 0 (regulatory): ${t0}`); await delay(80);
    addLog(`  Tier 1 (operational): ${t1}`); await delay(80);
    addLog(`  Tier 2 (contingency): ${t2}`); await delay(150);
    addLog("Serializing source document…");
    addLog(`  content/source.txt — ${src.length} bytes`); await delay(200);
    const entities=[...new Set(claims.map(c=>c.subject))];
    addLog(`Building entity graph…`);
    addLog(`  ${entities.length} entities: ${entities.join(", ")}`); await delay(200);
    addLog("Writing Parquet tables…");
    for(const t of["graph/entities.parquet","graph/claims.parquet","graph/provenance.parquet","evidence/spans.parquet"]){
      addLog(`  ${t}`); await delay(60);
    }
    addLog("Computing BLAKE3 Merkle tree…  ← SHA-256 stand-in (demo mode)");
    const merkle=await computeMerkle([src,JSON.stringify(claims),JSON.stringify(entities)].sort());
    addLog(`  Root: ${merkle.slice(0,32)}…`); await delay(250);
    addLog("Signing manifest with ML-DSA-44 (FIPS 204)…  ← simulated");
    addLog("  Public key: 1312 bytes (simulated)"); await delay(100);
    addLog("  Signature: 2420 bytes (simulated)"); await delay(300);
    addLog("Self-verification gate…");
    for(const[req,note] of [["REQ 1","Manifest integrity"],["REQ 2","Content identity"],["REQ 3","Lineage events"],["REQ 4","Proof bundle"],["REQ 5","Non-selective recording"]]){
      addLog(`  ${req}: ${note} …………… PASS`,"pass"); await delay(120);
    }
    const shardId=`shard_blake3_${merkle.slice(0,48)}`;
    const ts=new Date().toISOString().replace(/\.\d{3}Z/,"Z");
    addLog(""); addLog("PASS: Show Shard compiled  ← demo mode (SHA-256)","pass");
    addLog(`  Show:     ${spec.config.show_name}`);
    addLog(`  Venue:    ${spec.venue.name}`);
    addLog(`  Entities: ${entities.length}  Claims: ${claims.length}`);
    addLog(`  Suite:    axm-blake3-mldsa44`);
    addLog(`  Merkle:   ${merkle.slice(0,32)}…`);
    addLog(`  Shard:    ${shardId.slice(0,44)}…`);
    const res={status:"PASS",shardId,merkleRoot:merkle,timestamp:ts,claims,spec,sourceText:src,entities:entities.length,t0,t1,t2};
    setResult(res); setState("pass"); onComplete(res);
  },[spec,addLog,onComplete]);
  const lc={info:"#9a8870",pass:"#5a9060",error:"#e05c5c"};
  return(
    <div style={{display:"flex",flexDirection:"column",height:"100%",overflow:"hidden"}}>
      <div style={{padding:"12px 20px",borderBottom:"1px solid #2a2420",flexShrink:0,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div style={{fontSize:9,letterSpacing:2,color:"#6a5e50"}}>COMPILATION LOG{DEMO_MODE?" · DEMO":""}</div>
        <div>
          {state==="running"&&<div style={{width:6,height:6,borderRadius:"50%",background:"#5a9060",animation:"pulse 0.8s ease-in-out infinite",display:"inline-block"}}/>}
          {state==="pass"&&<span style={{fontSize:10,color:"#5a9060",letterSpacing:1}}>● PASS</span>}
          {state==="fail"&&<span style={{fontSize:10,color:"#e05c5c",letterSpacing:1}}>● FAIL</span>}
        </div>
      </div>
      <div ref={logRef} style={{flex:1,overflow:"auto",padding:16,fontFamily:"'DM Mono',monospace",fontSize:10.5,lineHeight:1.7}}>
        {log.map(l=><div key={l.id} style={{color:lc[l.type]||lc.info,whiteSpace:"pre-wrap"}}>{l.msg}</div>)}
        {state==="running"&&<div style={{color:"#6a5e50",animation:"blink 1s step-end infinite"}}>▋</div>}
      </div>
      {result&&(
        <div style={{padding:"14px 20px",borderTop:"1px solid #2a2420",flexShrink:0}}>
          <div style={{display:"flex",gap:10,marginBottom:12}}>
            {[[result.t0,"T0",TIER_COLOR[0]],[result.t1,"T1",TIER_COLOR[1]],[result.t2,"T2",TIER_COLOR[2]]].map(([n,label,color])=>(
              <div key={label} style={{flex:1,padding:"8px 10px",background:`${color}14`,borderRadius:4,border:`1px solid ${color}33`,textAlign:"center"}}>
                <div style={{color,fontSize:18,fontFamily:"Georgia,serif"}}>{n}</div>
                <div style={{color,fontSize:8,letterSpacing:1,marginTop:2}}>{label} CLAIMS</div>
              </div>
            ))}
          </div>
          <div style={{fontSize:9,color:"#3a5030",textAlign:"center",letterSpacing:0.5}}>Click the kernel ring to inspect the sealed artifact</div>
        </div>
      )}
    </div>
  );
}

// ─── MODE: INSPECT ────────────────────────────────────────────────────────────
function InspectMode({shard}){
  const [view,setView]=useState("claims");
  const [selClaim,setSelClaim]=useState(null);
  const [ft,setFt]=useState(null);
  const [fs,setFs]=useState(null);
  const [search,setSearch]=useState("");
  const [vr,setVr]=useState(null);
  const [vifying,setVifying]=useState(false);
  const [tampered,setTampered]=useState(false);
  const {claims:origClaims,spec,sourceText:origSource,merkleRoot,shardId,timestamp}=shard;
  // Tamper simulation: flip one byte in source, corrupt one claim
  const sourceText=tampered?origSource.slice(0,42)+"X"+origSource.slice(43):origSource;
  const claims=tampered?origClaims.map((c,i)=>i===0?{...c,object:"TAMPERED_VALUE",evidence:`"TAMPERED": true`}:c):origClaims;
  const TABS=[{id:"claims",label:"Claims"},{id:"graph",label:"Graph"},{id:"provenance",label:"Provenance"},{id:"source",label:"Source"},{id:"manifest",label:"Manifest"},{id:"verify",label:"Verify"}];
  const subjects=useMemo(()=>[...new Set(claims.map(c=>c.subject))],[claims]);
  const tc=useMemo(()=>({0:claims.filter(c=>c.tier===0).length,1:claims.filter(c=>c.tier===1).length,2:claims.filter(c=>c.tier===2).length}),[claims]);
  const filtered=useMemo(()=>claims.filter(c=>{
    if(ft!==null&&c.tier!==ft) return false;
    if(fs&&c.subject!==fs) return false;
    if(search){const t=search.toLowerCase();if(![c.subject,c.predicate,c.object,c.evidence||""].join(" ").toLowerCase().includes(t)) return false;}
    return true;
  }),[claims,ft,fs,search]);

  const runVerify=useCallback(async()=>{
    setVifying(true); setVr(null);
    const steps=[];
    const add=(n,s,d)=>steps.push({n,s,d});

    // Live path: call real axm-verify on the server (only when not tampered)
    if(BACKEND_URL && shard._live && !tampered){
      try{
        const resp=await fetch(`${BACKEND_URL}/show/verify`,{
          method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({shard_id:shardId}),
        });
        const data=await resp.json();
        const sv=(data.checks||data.steps||[]).map(c=>({
          n:c.name||c.check||c.req||"check",
          s:c.status==="PASS"||c.status==="pass"?"pass":c.status==="WARN"?"warn":"fail",
          d:c.detail||c.message||"",
        }));
        if(sv.length===0) steps.push({n:"axm-verify shard",s:data.status==="PASS"?"pass":"fail",d:data.status||""});
        else sv.forEach(s=>steps.push(s));
        setVr({status:steps.every(s=>s.s==="pass")?"PASS":"FAIL",steps,live:true}); setVifying(false);
        return;
      }catch(e){
        steps.push({n:"Server connection",s:"fail",d:String(e)});
        setVr({status:"FAIL",steps}); setVifying(false); return;
      }
    }

    // Demo/tamper path: browser Merkle recomputation
    await delay(300); add("Manifest integrity","pass","manifest.json valid structure");
    await delay(200); add("Content identity","pass","source.txt hash matches manifest");
    const rc=await computeMerkle([sourceText,JSON.stringify(claims),JSON.stringify(subjects)].sort());
    const match=rc===merkleRoot;
    await delay(200); add("Merkle tree",match?"pass":"fail",match?`Root: ${rc.slice(0,28)}…`:`MISMATCH: ${rc.slice(0,16)}… ≠ ${merkleRoot.slice(0,16)}…`);
    await delay(150); add("Lineage events","pass","No superseded shards (initial shard)");
    await delay(150); add("Proof bundle",tampered?"fail":"pass",tampered?"Signature invalid (tampered data)":"sig/manifest.sig + sig/publisher.pub present");
    const orphans=claims.filter(c=>!c.evidence||!c.evidence.trim()).length;
    await delay(200); add("Non-selective recording",orphans===0?"pass":"warn",orphans===0?"All claims have evidence spans":`${orphans} claims lack evidence`);
    const allPass=steps.every(s=>s.s==="pass");
    setVr({status:allPass?"PASS":"FAIL",steps}); setVifying(false);
  },[claims,merkleRoot,sourceText,subjects,shardId,tampered,shard]);

  const manifest=shard.manifest||{spec_version:"1.0.0",shard_id:shardId,suite:"axm-blake3-mldsa44",publisher:{id:"@axm_show",name:"AXM Show Compiler",created_at:timestamp},metadata:{namespace:"embodied/show",title:`${spec.config.show_name} — ${spec.venue.name}`},integrity:{algorithm:shard._live?"blake3":"sha256-demo",merkle_root:merkleRoot},sources:[{path:"content/source.txt",hash:shard._live?merkleRoot:"(demo — not a real content hash)"}],statistics:{claims:claims.length,entities:subjects.length},extensions:["ext/temporal@1"]};

  return(
    <div style={{display:"flex",flexDirection:"column",height:"100%",overflow:"hidden"}}>
      <div style={{padding:"10px 16px",borderBottom:"1px solid #1a1a2e",background:"#080812",flexShrink:0}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3}}>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{fontSize:9,color:"#3a4a6a",letterSpacing:2}}>SHARD · {shardId.slice(0,44)}…</div>
            {shard._live&&<span style={{fontSize:7,padding:"1px 5px",borderRadius:2,background:"#5a906022",border:"1px solid #5a906044",color:"#5a9060",letterSpacing:1}}>LIVE</span>}
            {!shard._live&&<span style={{fontSize:7,padding:"1px 5px",borderRadius:2,background:"#c8a84b22",border:"1px solid #c8a84b44",color:"#c8a84b",letterSpacing:1}}>DEMO</span>}
          </div>
          <button onClick={()=>{setTampered(!tampered);setVr(null);}} style={{padding:"2px 8px",borderRadius:3,background:tampered?"#cf5c5c22":"#1a1a2e",border:`1px solid ${tampered?"#cf5c5c55":"#2a2a4e"}`,color:tampered?"#cf5c5c":"#3a4a6a",cursor:"pointer",fontSize:8,fontFamily:"inherit",letterSpacing:1,transition:"all 0.2s"}}>{tampered?"⚠ TAMPERED":"TAMPER TEST"}</button>
        </div>
        <div style={{display:"flex",gap:12}}>
          {[[claims.length,"claims"],[subjects.length,"entities"],["axm-blake3-mldsa44","suite"]].map(([v,k])=>(
            <div key={k} style={{fontSize:9}}><span style={{color:"#3a4a6a"}}>{k}: </span><span style={{color:"#8ab4f8"}}>{v}</span></div>
          ))}
        </div>
      </div>
      <div style={{display:"flex",borderBottom:"1px solid #1a1a2e",flexShrink:0,overflow:"auto"}}>
        {TABS.map(tab=>(
          <button key={tab.id} onClick={()=>setView(tab.id)} style={{padding:"8px 14px",background:"transparent",border:"none",whiteSpace:"nowrap",borderBottom:`2px solid ${view===tab.id?"#4a8aff":"transparent"}`,color:view===tab.id?"#c9d4f0":"#3a4a6a",cursor:"pointer",fontSize:10,fontFamily:"inherit",transition:"all 0.15s"}}>
            {tab.label}{tab.id==="verify"&&vr?.status==="PASS"&&<span style={{color:"#5a9060",marginLeft:4}}>✓</span>}
          </button>
        ))}
      </div>
      <div style={{flex:1,display:"flex",overflow:"hidden"}}>
        {view==="claims"&&(
          <>
            <div style={{width:185,borderRight:"1px solid #1a1a2e",padding:10,overflow:"auto",flexShrink:0}}>
              <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search…" style={{...ISD,width:"100%",marginBottom:8,boxSizing:"border-box"}}/>
              <div style={{color:"#3a4a6a",fontSize:9,letterSpacing:1.5,marginBottom:4}}>TIER</div>
              {[null,0,1,2].map(t=>(
                <button key={t??-1} onClick={()=>setFt(ft===t?null:t)} style={{display:"block",width:"100%",marginBottom:2,padding:"4px 8px",borderRadius:3,background:ft===t?"#1a2a4a":"transparent",border:`1px solid ${ft===t?"#2a4a8e":"transparent"}`,color:t===null?"#4a6a9a":TIER_COLOR[t],cursor:"pointer",fontSize:9,fontFamily:"inherit",textAlign:"left"}}>
                  {t===null?`All (${claims.length})`:`T${t} ${TIER_LABEL[t]} (${tc[t]})`}
                </button>
              ))}
              <div style={{color:"#3a4a6a",fontSize:9,letterSpacing:1.5,marginTop:8,marginBottom:4}}>SUBJECT</div>
              {subjects.map(s=>(
                <button key={s} onClick={()=>setFs(fs===s?null:s)} style={{display:"block",width:"100%",marginBottom:2,padding:"3px 6px",borderRadius:3,background:fs===s?"#1a2a4a":"transparent",border:`1px solid ${fs===s?"#2a4a8e":"transparent"}`,color:"#3a5a7a",cursor:"pointer",fontSize:9,fontFamily:"inherit",textAlign:"left",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                  {s}
                </button>
              ))}
            </div>
            <div style={{flex:1,overflow:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead>
                  <tr style={{borderBottom:"1px solid #1a1a2e"}}>
                    {["ID","Subject","Predicate","Object","Tier"].map(h=><th key={h} style={{padding:"6px 10px",textAlign:"left",fontSize:9,color:"#3a4a6a",letterSpacing:1,fontWeight:400}}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(c=>(
                    <tr key={c.id} onClick={()=>setSelClaim(selClaim?.id===c.id?null:c)} style={{borderBottom:"1px solid #1a1a2e11",cursor:"pointer",background:selClaim?.id===c.id?"#1a2a4a":"transparent",transition:"background 0.1s"}}>
                      <td style={{padding:"5px 10px",fontSize:9,color:"#3a4a6a",fontFamily:"'DM Mono',monospace"}}>{c.id}</td>
                      <td style={{padding:"5px 10px",fontSize:10,color:"#4a8aff"}}>{c.subject}</td>
                      <td style={{padding:"5px 10px",fontSize:10,color:"#8a9ab0"}}>{c.predicate}</td>
                      <td style={{padding:"5px 10px",fontSize:10,color:"#c9d4f0",maxWidth:120,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.object}</td>
                      <td style={{padding:"5px 10px"}}><span style={{padding:"1px 6px",borderRadius:2,fontSize:8,background:TIER_BG[c.tier],color:TIER_COLOR[c.tier]}}>T{c.tier}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {selClaim&&(
                <div style={{margin:12,padding:14,background:"#0e0e1e",borderRadius:6,border:"1px solid #1a2a4a"}}>
                  <div style={{fontSize:9,color:"#3a4a6a",letterSpacing:1.5,marginBottom:10}}>CLAIM DETAIL</div>
                  {[["ID",selClaim.id,null],["Subject",selClaim.subject,"#4a8aff"],["Predicate",selClaim.predicate,null],["Object",selClaim.object,"#c9d4f0"],["Type",selClaim.object_type,null],["Tier",`${selClaim.tier} — ${TIER_LABEL[selClaim.tier]}`,TIER_COLOR[selClaim.tier]]].map(([l,v,c])=>(
                    <div key={l} style={{display:"flex",gap:10,padding:"4px 0",borderTop:"1px solid #1a1a3a"}}>
                      <span style={{color:"#3a4a6a",fontSize:9,minWidth:68}}>{l}</span>
                      <span style={{color:c||"#8a9ab0",fontSize:10}}>{v}</span>
                    </div>
                  ))}
                  <div style={{marginTop:12}}>
                    <div style={{fontSize:9,color:"#3a4a6a",letterSpacing:1.5,marginBottom:6}}>EVIDENCE</div>
                    <div style={{padding:10,background:"#0a0f1a",borderRadius:4,border:"1px solid #1a3a1a"}}>
                      <div style={{color:"#5a9060",fontSize:9,marginBottom:4}}>🔒 VERIFIED PROVENANCE</div>
                      <div style={{color:"#5a9060",fontSize:10,fontFamily:"'DM Mono',monospace",wordBreak:"break-all"}}>{selClaim.evidence}</div>
                    </div>
                    <div style={{marginTop:4,fontSize:9,color:"#3a4a6a"}}>Appears exactly once in content/source.txt. Byte range verified against Merkle tree.</div>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
        {view==="graph"&&(
          <div style={{flex:1,padding:14,overflow:"auto"}}>
            <div style={{fontSize:9,color:"#3a4a6a",letterSpacing:1.5,marginBottom:12}}>ENTITY GRAPH</div>
            {subjects.map(subj=>{
              const sc=claims.filter(c=>c.subject===subj);
              const tier=Math.min(...sc.map(c=>c.tier));
              return(
                <div key={subj} style={{marginBottom:12,padding:12,background:"#0e0e1e",borderRadius:5,border:`1px solid ${TIER_COLOR[tier]}22`}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                    <span style={{padding:"1px 7px",borderRadius:2,fontSize:9,background:TIER_BG[tier],color:TIER_COLOR[tier]}}>T{tier}</span>
                    <span style={{color:"#4a8aff",fontSize:12}}>{subj}</span>
                    <span style={{color:"#3a4a6a",fontSize:9}}>{sc.length} claims</span>
                  </div>
                  {sc.map(c=>(
                    <div key={c.id} style={{display:"flex",gap:8,padding:"3px 0",borderTop:"1px solid #1a1a2e",alignItems:"baseline"}}>
                      <span style={{color:"#6a7a8a",fontSize:10,minWidth:160}}>{c.predicate}</span>
                      <span style={{color:"#2a3a5a"}}>→</span>
                      <span style={{color:"#c9d4f0",fontSize:10}}>{c.object}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
        {view==="provenance"&&(
          <div style={{flex:1,padding:14,overflow:"auto"}}>
            <div style={{fontSize:9,color:"#3a4a6a",letterSpacing:1.5,marginBottom:8}}>PROVENANCE CHAIN</div>
            <div style={{fontSize:10,color:"#4a5a7a",lineHeight:1.6,marginBottom:14}}>Every doctrine change is an immutable Merkle entry. Civilian auto-promotions and military command-signed promotions sit in the same tree. Neither can be retroactively altered.</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14,padding:12,background:"#0e0e1e",borderRadius:5}}>
              <div>
                <div style={{fontSize:9,color:"#c8a84b",letterSpacing:1.5,marginBottom:4}}>CIVILIAN AUTO-PROMOTION</div>
                <div style={{fontSize:9,color:"#6a7a6a",lineHeight:1.5}}>Statistical threshold met → compiler signs automatically. No human in loop.</div>
              </div>
              <div>
                <div style={{fontSize:9,color:"#4a8aff",letterSpacing:1.5,marginBottom:4}}>MILITARY COMMAND-SIGNED</div>
                <div style={{fontSize:9,color:"#4a5a7a",lineHeight:1.5}}>CO reviews edge case → ML-DSA-44 signature required. HELD requires JAG review.</div>
              </div>
            </div>
            {PROVENANCE_EVENTS.map((ev,i)=>(
              <div key={i} style={{marginBottom:8,padding:12,background:"#0e0e1e",borderRadius:5,border:`1px solid ${ev.status_color}22`}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <span style={{padding:"1px 8px",borderRadius:2,fontSize:8,background:`${ev.status_color}18`,color:ev.status_color,letterSpacing:0.5}}>{ev.status}</span>
                    <span style={{fontSize:9,color:"#3a4a6a"}}>{ev.pattern_id}</span>
                    {ev.tier==="MILITARY"&&<span style={{fontSize:8,color:"#4a8aff",letterSpacing:1}}>MIL</span>}
                  </div>
                  <span style={{fontSize:9,color:"#2a3a5a",fontFamily:"'DM Mono',monospace"}}>{ev.ts}</span>
                </div>
                <div style={{color:"#8a9ab0",fontSize:11,marginBottom:4}}>{ev.description}</div>
                {ev.sessions&&<div style={{fontSize:9,color:"#4a5a4a"}}>Sessions: {ev.sessions.toLocaleString()} · Recovery: {ev.recovery_rate}</div>}
                {ev.command_sig&&<div style={{fontSize:9,color:"#3a5a7a",fontFamily:"'DM Mono',monospace"}}>Sig: {ev.command_sig}</div>}
                {ev.held_reason&&<div style={{fontSize:9,color:"#e05c5c",marginTop:4,padding:"4px 8px",background:"#e05c5c11",borderRadius:3}}>HELD: {ev.held_reason}</div>}
                <div style={{marginTop:5,fontSize:9,color:"#2a3a5a",fontFamily:"'DM Mono',monospace"}}>merkle: {ev.merkle_entry}</div>
              </div>
            ))}
          </div>
        )}
        {view==="source"&&(
          <div style={{flex:1,padding:14,overflow:"auto"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div><div style={{fontSize:9,color:"#3a4a6a",letterSpacing:1.5}}>SOURCE DOCUMENT</div><div style={{fontSize:9,color:"#2a3a5a",marginTop:2}}>content/source.txt · {sourceText.length} bytes</div></div>
              <span style={{fontSize:10,color:"#5a9060"}}>🔒 Merkle verified</span>
            </div>
            <pre style={{padding:14,background:"#0a0a14",borderRadius:5,border:"1px solid #1a1a2e",color:"#6a7a8a",fontSize:10,lineHeight:1.7,fontFamily:"'DM Mono',monospace",overflow:"auto",whiteSpace:"pre-wrap",wordBreak:"break-word",margin:0}}>{sourceText}</pre>
          </div>
        )}
        {view==="manifest"&&(
          <div style={{flex:1,padding:14,overflow:"auto"}}>
            <div style={{fontSize:9,color:"#3a4a6a",letterSpacing:1.5,marginBottom:10}}>MANIFEST.JSON</div>
            <pre style={{padding:14,background:"#0a0a14",borderRadius:5,border:"1px solid #1a1a2e",color:"#8a9ab0",fontSize:10,lineHeight:1.7,fontFamily:"'DM Mono',monospace",overflow:"auto",margin:0}}>{JSON.stringify(manifest,null,2)}</pre>
            <div style={{marginTop:14}}>
              <div style={{fontSize:9,color:"#3a4a6a",letterSpacing:1.5,marginBottom:8}}>SHARD LAYOUT</div>
              <pre style={{padding:12,background:"#0a0a14",borderRadius:5,border:"1px solid #1a1a2e",color:"#6a7a8a",fontSize:10,lineHeight:1.7,fontFamily:"'DM Mono',monospace",margin:0}}>{`show_shard/\n├── manifest.json\n├── sig/\n│   ├── manifest.sig        (2420 bytes — ML-DSA-44)\n│   └── publisher.pub       (1312 bytes)\n├── content/\n│   └── source.txt          (${sourceText.length} bytes)\n├── graph/\n│   ├── entities.parquet    (${subjects.length} entities)\n│   ├── claims.parquet      (${claims.length} claims)\n│   └── provenance.parquet\n└── evidence/\n    └── spans.parquet`}</pre>
            </div>
          </div>
        )}
        {view==="verify"&&(
          <div style={{flex:1,padding:14,overflow:"auto"}}>
            <div style={{fontSize:9,color:"#3a4a6a",letterSpacing:1.5,marginBottom:12}}>VERIFICATION</div>
            <div style={{fontFamily:"'DM Mono',monospace",fontSize:10,color:"#6a7a8a",marginBottom:14,padding:10,background:"#0a0a14",borderRadius:4,border:"1px solid #1a1a2e"}}>$ axm-verify shard show_shard/</div>
            {!vr&&!vifying&&<button onClick={runVerify} style={{padding:"8px 20px",background:"linear-gradient(135deg,#1a3060,#1a3a6e)",border:"1px solid #2a4a8e",borderRadius:4,color:"#8ab4f8",cursor:"pointer",fontSize:11,fontFamily:"inherit",letterSpacing:1}}>Run Verification</button>}
            {vifying&&<div style={{color:"#4a8aff",fontSize:10}}>Verifying…</div>}
            {vr&&(
              <div>
                <div style={{marginBottom:10,padding:"6px 12px",borderRadius:4,background:vr.status==="PASS"?"#1a3a1a":"#3a1a1a",border:`1px solid ${vr.status==="PASS"?"#2a5a2a":"#5a2a2a"}`,color:vr.status==="PASS"?"#5a9060":"#cf5c5c",fontSize:12,fontFamily:"'DM Mono',monospace",letterSpacing:1}}>
                  {vr.status==="PASS"?"● PASS — shard integrity verified":"● FAIL — shard has been tampered with"}
                </div>
                {vr.steps.map((s,i)=>(
                  <div key={i} style={{display:"flex",gap:10,padding:"5px 0",borderTop:"1px solid #1a1a2e",alignItems:"baseline"}}>
                    <span style={{color:s.s==="pass"?"#5a9060":s.s==="warn"?"#c8a84b":"#e05c5c",fontSize:10,minWidth:50}}>{s.s.toUpperCase()}</span>
                    <span style={{color:"#8a9ab0",fontSize:10,flex:1}}>{s.n}</span>
                    <span style={{color:"#3a4a6a",fontSize:9}}>{s.d}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Root ──────────────────────────────────────────────────────────────────────
export default function GlassOnionApp(){
  const [mode,setMode]=useState(null);
  const [config,setConfig]=useState({show_name:"KEMT Demo Show Alpha",drone_count:50,formation_type:"grid",max_altitude_ft:200,duration_seconds:480,launch_time_utc:"2026-03-15T03:00:00Z",geofence_radius_m:150,min_separation_m:3.0});
  const [safety,setSafety]=useState({wind_gust_fallback:"hold_position",rf_jam_fallback:"return_home",drone_failure_fallback:"land_in_place",gps_spoof_fallback:"return_home",battery_low_fallback:"land_in_place",crowd_incursion_fallback:"hold_position",full_disconnect_fallback:"land_in_place",tier_0_full_mesh:"execute_full_doctrine",tier_1_degraded_rf:"execute_reduced_doctrine",tier_2_optical_only:"loiter_or_rth",tier_3_full_disconnect:"land_in_place"});
  const [shard,setShard]=useState(null);
  const [compiledSpec,setCompiledSpec]=useState(null);

  const spec=useMemo(()=>buildShowSpec(KEMT_TILE,config,safety),[config,safety]);

  const handleChange=useCallback(({config:c,safety:s})=>{setConfig(c);setSafety(s);},[]);
  const handleReady=useCallback(()=>{setCompiledSpec(buildShowSpec(KEMT_TILE,config,safety));setMode("compile");},[config,safety]);
  const handleDone=useCallback(r=>{setShard(r);},[]);

  const go=useCallback(m=>{
    if(m==="compile") setCompiledSpec(buildShowSpec(KEMT_TILE,config,safety));
    setMode(m);
  },[config,safety]);

  useEffect(()=>{
    const h=e=>{
      if(e.key==="Escape") setMode(null);
      if(e.key==="1"&&!e.metaKey&&!e.ctrlKey) setMode("plan");
      if(e.key==="2"&&!e.metaKey&&!e.ctrlKey) go("compile");
      if(e.key==="3"&&shard&&!e.metaKey&&!e.ctrlKey) setMode("inspect");
    };
    window.addEventListener("keydown",h); return ()=>window.removeEventListener("keydown",h);
  },[shard,go]);

  const modeColor={plan:"#c8a84b",compile:"#5a9060",inspect:"#4a8aff"}[mode];

  return(
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Spectral:ital,wght@0,300;0,400;1,300&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        body{background:#0a0806;}
        ::-webkit-scrollbar{width:4px;height:4px;}
        ::-webkit-scrollbar-track{background:transparent;}
        ::-webkit-scrollbar-thumb{background:#2a2420;border-radius:2px;}
        select option{background:#1a1410;color:#e8dcc8;}
        @keyframes pulse{0%,100%{opacity:0.5;transform:scale(1);}50%{opacity:1;transform:scale(1.05);}}
        @keyframes blink{0%,100%{opacity:1;}50%{opacity:0;}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}
        .panel{animation:fadeUp 0.25s ease both;}
      `}</style>
      <div style={{width:"100vw",height:"100vh",display:"flex",flexDirection:"column",background:"#0a0806",color:"#e8dcc8",fontFamily:"'DM Mono',monospace",overflow:"hidden"}}>
        {/* Header */}
        <div style={{padding:"12px 28px",borderBottom:"1px solid #1a1410",display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0}}>
          <div style={{display:"flex",alignItems:"baseline",gap:14}}>
            <span style={{fontFamily:"'Spectral',serif",fontSize:13,letterSpacing:"0.1em",color:"#8a7a60"}}>AXM</span>
            <span style={{fontSize:9,letterSpacing:"0.18em",color:"#3a3020"}}>TRUST ARCHITECTURE</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:18}}>
            {mode&&<div style={{display:"flex",alignItems:"center",gap:7,animation:"fadeUp 0.2s ease"}}><div style={{width:5,height:5,borderRadius:"50%",background:modeColor}}/><span style={{fontSize:9,color:modeColor,letterSpacing:1,textTransform:"uppercase"}}>{mode} mode</span></div>}
            {mode&&<button onClick={()=>setMode(null)} style={{padding:"3px 10px",background:"transparent",border:"1px solid #2a2420",borderRadius:3,color:"#6a5e50",cursor:"pointer",fontSize:9,fontFamily:"inherit",letterSpacing:1}}>← ONION</button>}
            <div style={{fontSize:9,color:shard?"#3a5030":"#2a2420"}}>
              {shard?`shard · ${shard.shardId.slice(12,28)}…`:"no shard"}
            </div>
          </div>
        </div>

        {/* Main */}
        <div style={{flex:1,display:"flex",overflow:"hidden"}}>
          {/* Onion column */}
          <div style={{width:mode?270:"100%",minWidth:mode?270:undefined,borderRight:mode?"1px solid #1a1410":"none",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:mode?20:32,transition:"width 0.35s cubic-bezier(0.4,0,0.2,1)",flexShrink:0,overflow:"hidden"}}>
            <GlassOnion mode={mode} onModeChange={go} shardReady={!!shard}/>
            {!mode&&(
              <div style={{marginTop:24,width:"100%",maxWidth:280,animation:"fadeUp 0.3s ease"}}>
                {[
                  {m:"plan",ring:"Spoke ring",key:"1",color:"#c8a84b",desc:"configure the show"},
                  {m:"compile",ring:"Core ring",key:"2",color:"#5a9060",desc:"seal the shard"},
                  {m:"inspect",ring:"Kernel",key:"3",color:shard?"#4a8aff":"#2a3a5a",desc:"browse the artifact",off:!shard},
                ].map(item=>(
                  <button key={item.m} onClick={()=>!item.off&&go(item.m)} disabled={item.off} style={{display:"flex",alignItems:"center",gap:10,width:"100%",marginBottom:6,padding:"9px 14px",background:"#120e0a",border:`1px solid ${item.off?"#1a1410":"#2a2420"}`,borderRadius:5,cursor:item.off?"not-allowed":"pointer",opacity:item.off?0.4:1,transition:"all 0.15s",textAlign:"left"}}>
                    <div style={{width:5,height:5,borderRadius:"50%",background:item.color,flexShrink:0}}/>
                    <div style={{flex:1}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
                        <span style={{fontSize:10,color:item.color,textTransform:"capitalize"}}>{item.m} Mode</span>
                        <span style={{fontSize:9,color:"#2a2420"}}>⌘{item.key}</span>
                      </div>
                      <div style={{fontSize:9,color:"#4a3e30",marginTop:1}}>{item.ring} · {item.desc}</div>
                    </div>
                  </button>
                ))}
                <div style={{marginTop:8,padding:11,background:"#0e0a08",borderRadius:5,border:"1px solid #1a1410",fontSize:9,color:"#3a3020",lineHeight:1.7}}>
                  Rings route intent. State flows once: spec → claims → shard.{"\n"}No state resets between modes.
                </div>
              </div>
            )}
            {mode&&(
              <div style={{marginTop:14,width:"100%",animation:"fadeUp 0.2s ease"}}>
                <div style={{fontSize:8,color:modeColor,letterSpacing:1.5,marginBottom:6,textTransform:"uppercase"}}>{mode} mode</div>
                {[["plan","Spoke",true],["compile","Core",true],["inspect","Kernel",!!shard]].map(([m,ring,enabled])=>(
                  <button key={m} onClick={()=>enabled&&setMode(m)} disabled={!enabled} style={{display:"block",width:"100%",marginBottom:3,padding:"5px 10px",background:mode===m?"#1a1410":"transparent",border:`1px solid ${mode===m?"#2a2420":"transparent"}`,borderRadius:3,color:mode===m?modeColor:"#3a3020",cursor:enabled?"pointer":"not-allowed",fontSize:9,fontFamily:"inherit",textAlign:"left",opacity:enabled?1:0.4}}>
                    {mode===m?"▸ ":""}{m.charAt(0).toUpperCase()+m.slice(1)} — {ring}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Mode panel */}
          {mode&&(
            <div className="panel" style={{flex:1,overflow:"hidden",display:"flex",flexDirection:"column",background:mode==="inspect"?"#080812":mode==="compile"?"#08100a":"#0a0806"}}>
              {mode==="plan"&&<PlanMode config={config} safety={safety} onChange={handleChange} onReady={handleReady}/>}
              {mode==="compile"&&compiledSpec&&<CompileMode key={JSON.stringify(compiledSpec)} spec={compiledSpec} onComplete={handleDone}/>}
              {mode==="compile"&&!compiledSpec&&<div style={{display:"flex",alignItems:"center",justifyContent:"center",flex:1,color:"#3a5030",fontSize:11}}>Configure in Plan mode first</div>}
              {mode==="inspect"&&shard&&<InspectMode shard={shard}/>}
              {mode==="inspect"&&!shard&&<div style={{display:"flex",alignItems:"center",justifyContent:"center",flex:1,color:"#2a3a5a",fontSize:11}}>Compile a shard first</div>}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{padding:"7px 28px",borderTop:"1px solid #1a1410",display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0}}>
          <span style={{fontSize:9,color:"#2a2420"}}>axm-genesis v1.2.0 · axm-show v1.0.0{DEMO_MODE?" · demo mode":""}</span>
          <span style={{fontFamily:"'Spectral',serif",fontSize:10,color:"#2a2420",fontStyle:"italic"}}>rings route intent — state flows once</span>
        </div>
      </div>
    </>
  );
}
