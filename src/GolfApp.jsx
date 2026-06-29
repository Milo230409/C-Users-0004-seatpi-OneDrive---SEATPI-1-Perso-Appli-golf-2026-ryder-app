import React, { useState, useEffect, useMemo, useRef, createContext, useContext } from "react";
import { supabase, supabaseEnabled } from "./supabaseClient";
import { loadGroup, upsertEntity, deleteEntity, deleteGameByDataId, dedupeGamesCloud, deleteAllGames, loadMyProfile, saveMyProfile, subscribeGroup } from "./supabaseSync";

/* ============================================================
   GOLF CLUB APP v3 — Parties du WE + Événements
   - Parcours avec PLUSIEURS DÉPARTS (tees) : couleur, CR/SSS, Slope, Par.
     Normes par pays (FR/US/UK/ES/perso).
   - Chaque joueur choisit SON départ → CHP calculé sur ce départ.
   - Événement : joueurs non affectés au départ. Équipes "Équipe 1 / Équipe 2"
     par défaut, renommables.
   ============================================================ */

const APP_VERSION="v3.70 · Ryder éditable + dorée"; // ← change à chaque mise en prod pour vérifier
// Valeurs par défaut EN DUR (toujours présentes, même sur un nouveau téléphone / cache vidé).
// Modifiables dans Réglages ; ce qui y est saisi remplace ces valeurs.
const DEFAULT_API_KEY="HZG53L3HRXILJV56FO5NENQQGU";
const DEFAULT_WA="https://chat.whatsapp.com/JRErxQfHbNkJ4xFutnjklk";
// Déconnexion auto après cette durée d'INACTIVITÉ (sauf si en partie en cours).
const SESSION_TIMEOUT=2*60*60*1000; // 2 heures
// Qui peut ouvrir le menu Réglages (clé API, lien WhatsApp…). Insensible à la casse.
// Ajoute ici les prénoms/surnoms autorisés.
const ADMIN_KEYS=["philippe","phil"];
function isAdmin(u){ if(!u) return false;
  const a=(u.name||"").trim().toLowerCase(), b=(u.nick||"").trim().toLowerCase();
  return ADMIN_KEYS.includes(a)||ADMIN_KEYS.includes(b); }
const T={
  bg:"#0a0f0c",        // fond quasi noir légèrement verdâtre
  panel:"#121a15",     // carte
  panel2:"#1a2620",    // carte surélevée / option active discrète
  line:"#2a3a30",      // bordures
  eu:"#1f6feb",        // bleu équipe
  us:"#ec3750",        // rouge équipe / accent "difficile"
  gold:"#f5c542",      // doré accent
  violet:"#7c5cff",    // accent secondaire (aléatoire)
  text:"#eef5ef",
  dim:"#7e9486",
  accent:"#86e01e",    // VERT FAIRWAY électrique = couleur d'action dominante
  accentDark:"#5fa810",
  ink:"#08110a",       // texte sur boutons verts
};

function todayTag(){const d=new Date(),p=n=>String(n).padStart(2,"0");
  return `${p(d.getDate())}${p(d.getMonth()+1)}${d.getFullYear()}`;}
function timeTag(){const d=new Date(),p=n=>String(n).padStart(2,"0");
  return `${p(d.getHours())}h${p(d.getMinutes())}`;}

const TEE_PRESETS={
  France:["Blanc","Jaune","Bleu","Rouge","Orange"],
  Espagne:["Noir","Blanc","Jaune","Bleu","Rouge"],
  USA:["Black","Blue","White","Gold","Red"],
  UK:["Black","White","Yellow","Blue","Red"],
  Perso:["Départ 1","Départ 2","Départ 3"],
};
const TEE_COLOR={Blanc:"#f4f4f4",Jaune:"#e7c14b",Bleu:"#3a7bd5",Rouge:"#d63a3a",
  Orange:"#e08a2b",Noir:"#222",Or:"#caa12e",
  Black:"#222",Blue:"#3a7bd5",White:"#f4f4f4",Gold:"#caa12e",
  Red:"#d63a3a",Yellow:"#e7c14b"};
const teeDot=t=>TEE_COLOR[t]||T.dim;
// nom affiché : surnom si renseigné, sinon prénom
const dispName=p=>p?.nick?.trim()||p?.name||"?";

function courseHandicap(index,slope,cr,par){
  if(index==null) return 0;
  return Math.round(index*((slope||113)/113)+((cr??par??72)-(par??72)));
}
// CHP effectif pour l'attribution des coups rendus :
//  - intégral (relative=false)  : chaque joueur reçoit son CHP complet (stroke play).
//  - différentiel (relative=true, match play) : on retranche le plus bas CHP du groupe,
//    donc le plus bas joue à 0 et les autres reçoivent l'ÉCART, sur les trous les plus durs.
function effChp(p,ps,course,relative){
  const t=teeData(course,p.tee);
  const raw=courseHandicap(p.index,t.slope,t.cr,t.par);
  if(!relative||!ps||ps.length<2) return raw;
  const min=Math.min(...ps.map(q=>{const tq=teeData(course,q.tee);
    return courseHandicap(q.index,tq.slope,tq.cr,tq.par);}));
  return raw-min;
}
function strokesPerHole(chp,si){
  const holes=(si&&si.length===18)?si:Array.from({length:18},(_,i)=>i+1);
  const res=new Array(18).fill(0);const n=Math.abs(chp),sign=chp<0?-1:1;
  for(let s=0;s<n;s++){const t=(s%18)+1;const idx=holes.indexOf(t);if(idx>=0)res[idx]+=sign;}
  return res;
}
function teeData(course,teeName){
  if(!course?.tees?.length) return {cr:72,slope:130,par:72};
  return course.tees.find(t=>t.name===teeName)||course.tees[0];
}
// par de chaque trou : utilise course.pars si présent, sinon répartit le par global
function holePars(course){
  if(course?.pars?.length===18) return course.pars;
  const par=course?.par||72;
  // répartition classique : surtout des 4, quelques 3 et 5 pour tomber sur le par total
  const base=new Array(18).fill(4);
  let diff=par-72; // ajuste autour de 72
  // 4 trous en par 3 et 4 en par 5 par défaut → reste à 72
  [3,6,8,12].forEach(i=>base[i]=3);
  [4,10,14,17].forEach(i=>base[i]=5);
  // corrige pour matcher le par réel
  let i=0;while(diff>0&&i<18){if(base[i]<5){base[i]++;diff--;}i++;}
  i=0;while(diff<0&&i<18){if(base[i]>3){base[i]--;diff++;}i++;}
  return base;
}
// renvoie la liste des n° de trous où le joueur reçoit ses coups (selon CHP + SI)
function strokeHoles(chp,si){
  const arr=strokesPerHole(chp,si);
  const out=[];
  arr.forEach((v,i)=>{ if(v>0) out.push({hole:i+1,n:v}); });
  return out;
}
// nombre de birdies nets : trous où le score net < par du trou (pour départage à égalité)
function countNetBirdies(netHoles,course){
  const pars=holePars(course);
  let b=0;
  netHoles.forEach((s,i)=>{ if(s!=null && s<pars[i]) b++; });
  return b;
}

/* ===== API GolfCourseAPI : recherche + détails (repli manuel si CORS) ===== */
const GolfAPI={
  key(){ return DB.lget("apiKey",DEFAULT_API_KEY); },
  async search(q){
    const k=this.key();
    if(!k) throw {kind:"nokey"};
    const r=await fetch(`https://api.golfcourseapi.com/v1/search?search_query=${encodeURIComponent(q)}`,
      {headers:{Authorization:"Key "+k}});
    if(!r.ok) throw {kind:"http",status:r.status};
    const d=await r.json();
    return (d.courses||[]).slice(0,8);
  },
  // diagnostic : renvoie un texte clair sur ce qui se passe réellement
  async test(){
    const k=this.key();
    if(!k) return "❌ Aucune clé enregistrée. Colle ta clé ci-dessus et enregistre-la.";
    try{
      const r=await fetch("https://api.golfcourseapi.com/v1/search?search_query=pals",
        {headers:{Authorization:"Key "+k}});
      if(r.status===401||r.status===403)
        return `❌ Clé refusée (${r.status}). Vérifie que la clé est correcte et active sur golfcourseapi.com.`;
      if(!r.ok) return `⚠️ Réponse HTTP ${r.status}. L'API a répondu mais avec une erreur.`;
      const d=await r.json();
      const n=(d.courses||[]).length;
      return `✅ Connexion OK ! La clé fonctionne (${n} parcours trouvés pour "pals"). L'autocomplétion devrait marcher.`;
    }catch(e){
      // une erreur réseau/TypeError ici = quasi toujours un blocage CORS du navigateur
      return "🚫 Appel bloqué par le navigateur (CORS). Ta clé n'est pas en cause : c'est une "+
        "protection du navigateur contre les appels directs vers cette API. Solution : passer "+
        "par un relais (Supabase). En attendant, saisis les parcours manuellement.";
    }
  },
  // transforme un résultat API en parcours interne avec ses départs + détail trou par trou
  toCourse(c){
    const tees=[];
    let pars=null, si=null;
    const grab=(arr)=>{(arr||[]).forEach(t=>{
      const holes=t.holes||[];
      const tSi=holes.map(h=>h.handicap).filter(x=>x!=null);
      const tPar=holes.map(h=>h.par).filter(x=>x!=null);
      // longueur totale du départ : champ direct ou somme des trous
      const len=t.total_yards||t.total_meters||
        (holes.reduce((s,h)=>s+(h.yardage||h.length||0),0)||null);
      if(!si && tSi.length===18) si=tSi;
      if(!pars && tPar.length===18) pars=tPar;
      tees.push({name:t.tee_name||"Départ", cr:t.course_rating, slope:t.slope_rating,
        par:t.par_total, length:len||undefined, si:tSi.length===18?tSi:undefined});});};
    grab(c.tees?.male); grab(c.tees?.female);
    if(!si) si=Array.from({length:18},(_,i)=>i+1);
    const course={id:Date.now(), apiId:c.id, source:"api", updated:Date.now(),
      name:`${c.club_name} — ${c.course_name}`,
      country:"—", par:tees[0]?.par||(pars?pars.reduce((a,b)=>a+b,0):72), si,
      tees:tees.length?tees:[{name:"Standard",cr:72,slope:130,par:72}]};
    if(pars) course.pars=pars; // par réel de chaque trou
    return course;
  },
  // recharge les données d'un parcours depuis l'API via son apiId (pour l'actualisation)
  async refresh(apiId){
    const k=this.key();
    if(!k||!apiId) throw {kind:"noref"};
    const r=await fetch(`https://api.golfcourseapi.com/v1/courses/${apiId}`,
      {headers:{Authorization:"Key "+k}});
    if(!r.ok) throw {kind:"http",status:r.status};
    const d=await r.json();
    return this.toCourse(d.course||d);
  }
};

function formulasFor(n){
  // Stableford apparaît UNE fois (le brut/net se choisit dans le 2e menu, pas ici).
  if(n===2) return ["matchplay","strokeplay_net","stableford","skins"];
  if(n===3) return ["chouette","onevonevone","stableford","skins"];
  if(n===4) return ["fourball","bestworst","foursome","scramble","chamble","mexicaine","stableford"];
  return ["stableford"];
}
// Formules qui se jouent uniquement en BRUT (pas de choix net) : on masque le 2e menu.
const BRUT_ONLY=["mexicaine"];
// Formules d'équipe 2 contre 2 : on demande qui joue avec qui.
const TEAM_2V2=["fourball","bestworst","foursome","scramble","chamble","mexicaine","matchplay2v2"];
const FORMULA_LABELS={matchplay:"Match Play 1v1",strokeplay_net:"Stroke Play 1v1",
  stableford:"Stableford",stableford_net:"Stableford Net",stableford_gross:"Stableford Brut",
  skins:"Skins (18 pts · report)",chouette:"Chouette (6 pts · 4/2/0)",
  onevonevone:"1v1v1 (match play à 3)",fourball:"Fourball (meilleure balle)",
  bestworst:"Fourball — meilleure & moins bonne",
  foursome:"Foursome / Greensome",mexicaine:"Mexicaine 2v2",
  scramble:"Scramble",chamble:"Chamble (drive en équipe)",matchplay2v2:"Match Play 2v2"};
// Libellés courts pour le NOM auto des parties (mode de jeu).
const FORMULA_SHORT={matchplay:"Match Play",strokeplay_net:"Stroke Play",stableford:"Stableford",
  skins:"Skins",chouette:"Chouette",onevonevone:"1v1v1",fourball:"Fourball",
  bestworst:"Fourball M&MB",foursome:"Foursome",mexicaine:"Mexicaine",scramble:"Scramble",
  chamble:"Chamble",matchplay2v2:"Match Play 2v2"};

function defaultFormula(size){return size===2?"matchplay":size===3?"chouette":"fourball";}
function autoSplit(n){
  const map={2:[[2,"matchplay"]],3:[[3,"chouette"]],4:[[4,"fourball"]],
    5:[[2,"matchplay"],[3,"chouette"]],6:[[2,"matchplay"],[4,"fourball"]],
    7:[[4,"fourball"],[3,"chouette"]],8:[[4,"fourball"],[4,"fourball"]],
    9:[[3,"chouette"],[3,"chouette"],[3,"chouette"]]};
  if(map[n]) return map[n].map(([size,formula])=>({size,formula}));
  const g=[];let r=n;while(r>=4){g.push({size:4,formula:"fourball"});r-=4;}
  if(r===3)g.push({size:3,formula:"chouette"});else if(r===2)g.push({size:2,formula:"matchplay"});
  else if(r===1&&g.length)g[g.length-1].size+=1;return g;
}
// Toutes les configurations possibles de n joueurs en flights de 2, 3 ou 4 (sans reste de 1).
// Renvoie des tableaux de tailles décroissantes, ex. 6 → [[4,2],[3,3],[2,2,2]].
function splitConfigs(n){
  const out=[];
  const rec=(rem,max,cur)=>{ if(rem===0){out.push([...cur]);return;}
    for(let s=Math.min(max,rem);s>=2;s--){ if(rem-s===1) continue; rec(rem-s,s,[...cur,s]); } };
  rec(n,4,[]);
  return out.sort((a,b)=>a.length-b.length || b[0]-a[0]); // moins de parties d'abord
}
// Applique une config (tailles) en gardant les formules existantes quand la taille ne change pas.
function applyConfig(prev,sizes){
  return sizes.map((size,i)=>({size,
    formula:(prev&&prev[i]&&prev[i].size===size)?prev[i].formula:defaultFormula(size)}));
}

// Tirage Ryder : chapeaux de 2 par index (les + proches ensemble), 1 joueur par chapeau dans
// chaque équipe. EN PLUS, on choisit le côté de chaque joueur pour rendre le TOTAL d'index
// des deux équipes le plus serré possible. Renvoie {assign:{id->0|1}, hats:[{a:idÉq0,b:idÉq1}]}.
function drawTeams(roster){
  const idx=p=>p.index||0;
  const sorted=[...roster].sort((a,b)=>idx(a)-idx(b));
  const pairs=[];for(let i=0;i<sorted.length;i+=2)pairs.push(sorted.slice(i,i+2));
  const assign={},hats=[];const tot=[0,0],cnt=[0,0];
  // chapeaux complets : on traite d'abord ceux au plus grand écart (impact max sur l'équilibre),
  // et pour chacun on met le joueur fort du côté qui resserre le plus les totaux.
  const full=pairs.filter(p=>p.length===2)
    .sort((p,q)=>Math.abs(idx(q[0])-idx(q[1]))-Math.abs(idx(p[0])-idx(p[1])));
  full.forEach(pair=>{
    const lo=idx(pair[0])<=idx(pair[1])?pair[0]:pair[1];
    const hi=lo===pair[0]?pair[1]:pair[0];
    const dA=Math.abs((tot[0]+idx(hi))-(tot[1]+idx(lo))); // hi→Éq0
    const dB=Math.abs((tot[0]+idx(lo))-(tot[1]+idx(hi))); // hi→Éq1
    const hiTo0 = dA<dB ? true : dB<dA ? false : Math.random()<.5; // égalité → aléatoire
    const t0=hiTo0?hi:lo, t1=hiTo0?lo:hi;
    assign[t0.id]=0;assign[t1.id]=1;tot[0]+=idx(t0);tot[1]+=idx(t1);cnt[0]++;cnt[1]++;
    hats.push({a:t0.id,b:t1.id});
  });
  // chapeau impair (1 joueur) : rejoint l'équipe au total d'index le plus faible
  const odd=pairs.find(p=>p.length===1);
  if(odd){const p=odd[0];const t=tot[0]<=tot[1]?0:1;assign[p.id]=t;tot[t]+=idx(p);cnt[t]++;
    hats.push(t===0?{a:p.id,b:null}:{a:null,b:p.id});}
  return {assign,hats};
}
// Énumère les configurations d'équipes possibles (1 joueur par chapeau dans chaque équipe),
// CLASSÉES de la plus équilibrée (écart de total d'index le plus faible) à la moins équilibrée.
// Permet de proposer le tirage le + pertinent, puis le 2e, le 3e… si on veut refaire.
function drawTeamConfigs(roster){
  const idx=p=>p.index||0;
  const sorted=[...roster].sort((a,b)=>idx(a)-idx(b));
  const pairs=[];for(let i=0;i<sorted.length;i+=2)pairs.push(sorted.slice(i,i+2));
  const full=pairs.filter(p=>p.length===2);
  const odd=pairs.find(p=>p.length===1)?.[0]||null;
  const h=full.length;
  const out=[],seen=new Set();
  for(let mask=0;mask<(1<<h);mask++){
    const assign={},hats=[];let t0=0,t1=0;
    full.forEach((pair,i)=>{const bit=(mask>>i)&1;
      const a=bit?pair[1]:pair[0],b=bit?pair[0]:pair[1]; // a→Éq0, b→Éq1
      assign[a.id]=0;assign[b.id]=1;t0+=idx(a);t1+=idx(b);hats.push({a:a.id,b:b.id});});
    if(odd){const t=t0<=t1?0:1;assign[odd.id]=t;
      if(t===0){t0+=idx(odd);hats.push({a:odd.id,b:null});}else{t1+=idx(odd);hats.push({a:null,b:odd.id});}}
    const team0=Object.keys(assign).filter(id=>assign[id]===0).sort().join(",");
    const team1=Object.keys(assign).filter(id=>assign[id]===1).sort().join(",");
    const key=[team0,team1].sort().join("|"); // dédupe miroir (Éq0/Éq1 interchangeables)
    if(seen.has(key))continue; seen.add(key);
    out.push({assign,hats,diff:Math.abs(t0-t1),tot:[Math.round(t0*10)/10,Math.round(t1*10)/10]});
  }
  out.sort((a,b)=>a.diff-b.diff);
  return out;
}
// Génère une PROPOSITION de confrontations par manche. Ryder = équipe contre équipe, mais le
// TIRAGE est INTÉGRAL (appariements aléatoires à chaque manche, PAS en fonction des chapeaux) :
//  - 1v1 = un joueur Éq0 (au hasard) contre un joueur Éq1 (au hasard) ;
//  - 2v2 = 2 joueurs Éq0 contre 2 joueurs Éq1 (au hasard) ;
//  - 6 joueurs / 4 manches : la dernière manche devient 2 chouettes (plus sympa) ;
//  - formules variées par manche. Modifiable ensuite à la main (formules + régénération).
function buildConfrontations(g){
  const roster=g.roster||[];const n=roster.length;
  if(!g.rounds) return g.rounds;
  const team0=roster.filter(p=>p.team===0), team1=roster.filter(p=>p.team===1);
  if(!team0.length||!team1.length) return g.rounds; // équipes pas encore formées
  return g.rounds.map((r,ri)=>{
    let plan=r.subgames.map(sg=>({size:(sg.players||[]).length||2,formula:sg.formula,id:sg.id}));
    if(n===6 && g.rounds.length===4 && ri===3)
      plan=[{size:3,formula:"chouette",id:1},{size:3,formula:"chouette",id:2}];
    // TIRAGE INTÉGRAL : on re-mélange chaque équipe à chaque manche.
    const A=shuffleArr(team0), B=shuffleArr(team1);
    const F1V1=["matchplay","stableford","skins","strokeplay_net"];
    const F2V2=["fourball","bestworst","scramble","chamble"];
    let c2=0,c4=0;
    const subs=plan.map(fl=>{
      let players=[],formula=fl.formula;
      if(fl.size===2){ formula=F1V1[(ri+c2++)%F1V1.length];
        const a=A.shift(),b=B.shift(); players=[a,b].filter(Boolean).map(p=>p.id); }
      else if(fl.size===4){ formula=F2V2[(ri+c4++)%F2V2.length];
        const picks=[A.shift(),A.shift(),B.shift(),B.shift()].filter(Boolean);
        players=picks.map(p=>p.id); }
      else if(fl.size===3){ // chouette : mélange des restants des 2 équipes
        const picks=[A.shift(),B.shift(),A.shift()||B.shift()].filter(Boolean);
        players=picks.map(p=>p.id); }
      return {id:fl.id,formula,players,scores:{},validated:[],done:false,hcpRelative:g.hcpRelative};
    });
    // sécurité : si un flight n'a pas son compte, on complète avec les joueurs restants
    const rest=[...A,...B];
    subs.forEach((s,si)=>{ const need=plan[si].size;
      while(s.players.length<need && rest.length) s.players.push(rest.shift().id); });
    return {...r,subgames:subs};
  });
}

// ===== COUPE (bracket à élimination directe, 1v1) =====
function shuffleArr(a){const r=[...a];for(let i=r.length-1;i>0;i--){
  const j=Math.floor(Math.random()*(i+1));[r[i],r[j]]=[r[j],r[i]];}return r;}
function coupeRoundName(nMatches){return nMatches===1?"Finale":nMatches===2?"Demi-finales"
  :nMatches===4?"Quarts de finale":nMatches===8?"8es de finale":`Tour (${nMatches} matchs)`;}
// Tirage FULL aléatoire du tour 1 (byes si nombre impair). Toutes les confrontations en 1v1.
function drawCoupe(roster,formula,courseId,hcpRel){
  const ids=shuffleArr((roster||[]).map(p=>p.id));const subgames=[];let id=1;
  for(let i=0;i<ids.length;i+=2){const players=i+1<ids.length?[ids[i],ids[i+1]]:[ids[i]];
    subgames.push({id:id++,formula,players,scores:{},validated:[],done:players.length<2,hcpRelative:hcpRel});}
  return [{id:1,name:coupeRoundName(subgames.length),courseId,subgames}];
}
// Vainqueur d'un duel 1v1 (id). Bye = le seul joueur. Sinon points du duel, départage net.
function matchWinnerId(sg,roster,course,net){
  const pl=sg.players||[];
  if(pl.length===1) return pl[0];
  const ps=pl.map(id=>roster.find(p=>String(p.id)===String(id))).filter(Boolean);
  if(ps.length<2||!course) return ps[0]?.id;
  const {pts}=playerScores(sg,ps,course,net);
  const sorted=[...ps].sort((a,b)=>(pts[b.id]||0)-(pts[a.id]||0));
  if((pts[sorted[0].id]||0)>(pts[sorted[1].id]||0)) return sorted[0].id;
  // égalité (ex All Square) → plus petit total net, puis meilleur index
  const netTot=p=>{const chp=effChp(p,ps,course,sg.hcpRelative);const st=strokesPerHole(chp,course.si);
    return (sg.validated||[]).reduce((s,h)=>{const g=sg.scores?.[p.id]?.[h];
      return g==null?s:s+(net?g-st[h]:g);},0);};
  return [...ps].sort((a,b)=>netTot(a)-netTot(b)||(a.index||0)-(b.index||0))[0].id;
}
// Tour suivant (si tour courant terminé) : on apparie les vainqueurs. null si pas prêt / fini.
function nextCoupeRound(g,courses){
  const net=g.mode==="net";const roster=g.roster||[];const rounds=g.rounds||[];
  if(!rounds.length) return null;
  const last=rounds[rounds.length-1];
  const course=courses.find(c=>c.id===last.courseId)||courses.find(c=>c.id===g.courseId);
  if(!last.subgames.every(sg=>sg.done||(sg.players||[]).length===1)) return null;
  const winners=last.subgames.map(sg=>matchWinnerId(sg,roster,course,net)).filter(Boolean);
  if(winners.length<=1) return null; // champion déjà connu
  const subgames=[];let id=1;
  for(let i=0;i<winners.length;i+=2){const players=i+1<winners.length?[winners[i],winners[i+1]]:[winners[i]];
    subgames.push({id:id++,formula:g.coupeFormula||"matchplay",players,scores:{},validated:[],
      done:players.length<2,hcpRelative:g.hcpRelative});}
  return [...rounds,{id:rounds.length+1,name:coupeRoundName(subgames.length),courseId:last.courseId,subgames}];
}
// Champion de la coupe (id) si la finale est jouée.
function coupeChampion(g,courses){
  const net=g.mode==="net";const rounds=g.rounds||[];if(!rounds.length) return null;
  const last=rounds[rounds.length-1];
  if(last.subgames.length===1 && last.subgames[0].done)
    return matchWinnerId(last.subgames[0],g.roster||[],courses.find(c=>c.id===last.courseId),net);
  return null;
}


const Ctx=createContext();
// Stockage persistant : écrit dans localStorage (survit aux rechargements et aux
// nouvelles livraisons sur le même domaine). Repli en mémoire si localStorage est
// indisponible (navigation privée, SSR…).
const DB={_mem:{},
  lget(k,d){
    try{const v=localStorage.getItem("dgda_"+k);return v!=null?JSON.parse(v):d;}
    catch(e){return this._mem[k]!==undefined?this._mem[k]:d;}
  },
  lset(k,v){
    this._mem[k]=v;
    try{localStorage.setItem("dgda_"+k,JSON.stringify(v));}catch(e){/* quota/privé */}
  }};

export default function App(){
  const [user,setUser]=useState(()=>DB.lget("user",null));
  // Plus d'authentification : accès libre. Données partagées via Supabase (clé publique).
  const [members,setMembers]=useState(()=>DB.lget("members",SEED_MEMBERS));
  const [games,setGames]=useState(()=>DB.lget("games",[]));
  const gamesRef=useRef(games); // dernier état connu (pour ne pousser QUE la partie modifiée)
  const [courses,setCourses]=useState(()=>DB.lget("courses",SEED_COURSES));
  const [tab,setTab]=useState("home");
  const [openGameId,setOpenGameId]=useState(null); // partie à ouvrir (ex: rejoindre)
  const openGame=(id)=>{ setOpenGameId(id); setTab("history"); };
  const [staleCount,setStaleCount]=useState(0);
  const [syncing,setSyncing]=useState(false);
  const [loaded,setLoaded]=useState(false);
  const cloud = supabaseEnabled; // partagé dès que les clés sont là (pas besoin de session)

  // ---- Chargement initial du groupe depuis Supabase (accès libre) ----
  useEffect(()=>{
    if(!cloud){ setLoaded(true); return; }
    let alive=true;
    (async()=>{
      setSyncing(true);
      const grp=await loadGroup();
      if(alive&&grp){
        setGames(grp.games||[]);
        if(grp.players?.length) setMembers(grp.players);
        if(grp.courses?.length) setCourses(grp.courses);
        // si la base n'a pas encore de parcours, on pousse le seed une 1re fois
        if(grp.courses?.length===0){
          for(const c of SEED_COURSES){ await upsertEntity("courses",c,null); }
          setCourses(SEED_COURSES);
        }
      }
      setSyncing(false); setLoaded(true);
    })();
    const unsub=subscribeGroup(async()=>{
      const grp=await loadGroup();
      if(alive&&grp){
        setGames(grp.games||[]); setMembers(grp.players||[]); setCourses(grp.courses||[]);
      }
    });
    return ()=>{alive=false;unsub&&unsub();};
  },[]);

  // ---- Ménage auto : on supprime les parties NON clôturées de plus d'1 semaine ----
  useEffect(()=>{
    const WEEK=7*24*3600*1000, now=Date.now();
    const stale=games.filter(g=>!g.done && g.created && (now-g.created)>WEEK);
    if(stale.length){
      const ids=new Set(stale.map(g=>g.id));
      setGames(games.filter(g=>!ids.has(g.id)));
      if(cloud) stale.forEach(g=>{ if(g._row) deleteEntity("games",g._row); });
    }
  },[games,cloud]);

  // ---- Déconnexion auto après inactivité — SAUF si le joueur est dans une partie en cours ----
  const lastActivity=useRef(Date.now());
  useEffect(()=>{ const bump=()=>{lastActivity.current=Date.now();};
    const evs=["click","keydown","touchstart","pointerdown"];
    evs.forEach(e=>window.addEventListener(e,bump));
    return ()=>evs.forEach(e=>window.removeEventListener(e,bump)); },[]);
  useEffect(()=>{
    if(!user) return;
    const iv=setInterval(()=>{
      const inGame=games.some(g=>!g.done && (g.roster||[]).some(p=>String(p.id)===String(user?.id)));
      if(!inGame && Date.now()-lastActivity.current>SESSION_TIMEOUT) setUser(null); // retour à "Qui es-tu ?"
    },60*1000);
    return ()=>clearInterval(iv);
  },[user,games]);
  // ---- Déconnexion quand on QUITTE l'appli (fermeture/arrière-plan) — sauf en partie ----
  useEffect(()=>{
    const onHide=()=>{ if(document.visibilityState!=="hidden") return;
      const inGame=games.some(g=>!g.done && (g.roster||[]).some(p=>String(p.id)===String(user?.id)));
      if(user && !inGame) setUser(null); };
    document.addEventListener("visibilitychange",onHide);
    window.addEventListener("pagehide",onHide);
    return ()=>{document.removeEventListener("visibilitychange",onHide);
      window.removeEventListener("pagehide",onHide);};
  },[user,games]);

  // ---- Persistance locale (toujours, pour le mode hors-ligne / invité) ----
  useEffect(()=>{ DB.lset("user",user); },[user]);
  useEffect(()=>{ if(!cloud) DB.lset("members",members); },[members,cloud]);
  useEffect(()=>{ if(!cloud) DB.lset("games",games); },[games,cloud]);
  useEffect(()=>{ if(!cloud) DB.lset("courses",courses); },[courses,cloud]);
  // gamesRef suit toujours l'état courant (y compris après un resync temps réel)
  useEffect(()=>{ gamesRef.current=games; },[games]);

  // wrappers qui sauvegardent dans le cloud (clé publique, pas d'userId)
  // On ne pousse QUE la/les partie(s) réellement modifiée(s), et on récupère le _row
  // (id de ligne cloud) dès la 1re écriture → la MÊME ligne est mise à jour ensuite
  // (sinon : doublons + synchro live qui ne se propage qu'à la validation finale).
  const saveGames=async(next)=>{
    const prev=gamesRef.current; gamesRef.current=next;
    setGames(next);
    if(!cloud) return;
    const strip=x=>JSON.stringify({...x,_row:undefined});
    for(const g of next){
      const before=prev.find(x=>String(x.id)===String(g.id));
      if(before && strip(before)===strip(g)) continue; // inchangée → on ne renvoie rien
      const rid=await upsertEntity("games",g,null);
      if(rid && !g._row) g._row=rid; // mémorise la ligne cloud pour les MAJ suivantes
    }
  };
  // suppression DÉFINITIVE d'une partie : il FAUT supprimer la ligne cloud,
  // sinon la partie revient au resync (cause du bug "je n'arrive pas à supprimer").
  const removeGame=async(game)=>{
    setGames(games.filter(x=>String(x.id)!==String(game.id)));
    // suppression DÉFINITIVE : on retire TOUTES les lignes de cette partie (doublons inclus)
    if(cloud) await deleteGameByDataId(game.id);
  };
  // Nettoyage des doublons de parties dans le cloud (réservé admin) + resync
  const cleanupDuplicates=async()=>{
    const n=cloud?await dedupeGamesCloud():0;
    const grp=cloud?await loadGroup():null;
    if(grp){ setGames(grp.games||[]); setMembers(grp.players||[]); setCourses(grp.courses||[]); }
    return n;
  };
  // Tout supprimer (repartir à zéro pour une nouvelle saison) — réservé admin
  const clearAllGames=async()=>{ setGames([]); if(cloud) await deleteAllGames(); };
  const saveMembers=async(next)=>{ setMembers(next);
    if(cloud){ for(const m of next){ await upsertEntity("players",m,null); } } };
  const saveCourses=async(next)=>{ setCourses(next);
    if(cloud){ for(const c of next){ await upsertEntity("courses",c,null); } } };

  const logout=()=>{ setUser(null); }; // "changer de joueur"
  useEffect(()=>{const SIX=183*24*3600*1000;const now=Date.now();
    const stale=courses.filter(c=>c.source==="api"&&c.apiId&&(now-(c.updated||0))>SIX);
    setStaleCount(stale.length);},[courses,user]);
  if(!user) return <WhoAreYou members={members} loaded={loaded} cloud={cloud}
    games={games} courses={courses} setMembers={saveMembers} onPick={setUser}/>;
  const LOGIN_ENABLED=true;
  // rafraîchit tous les parcours API périmés (sur action de l'utilisateur)
  const refreshStale=async()=>{
    const SIX=183*24*3600*1000;const now=Date.now();
    const stale=courses.filter(c=>c.source==="api"&&c.apiId&&(now-(c.updated||0))>SIX);
    let updated=[...courses],ok=0;
    for(const c of stale){
      try{const fresh=await GolfAPI.refresh(c.apiId);
        updated=updated.map(x=>x.id===c.id?{...fresh,id:c.id}:x);ok++;}
      catch(e){/* CORS/erreur : on garde l'ancien */}
    }
    setCourses(updated);setStaleCount(0);
    alert(ok>0?`${ok} parcours mis à jour.`:
      "Mise à jour impossible (API bloquée/CORS). Tes parcours restent utilisables.");
  };
  const tabs=[["home","Accueil","🏠"],["new","Nouvelle","➕"],
    ["players","Joueurs","👤"],["champ","Classement","🏅"],["history","Historique","📜"]];
  return (
    <Ctx.Provider value={{user,setUser,members,setMembers:saveMembers,
      games,setGames:saveGames,removeGame,courses,setCourses:saveCourses,
      cloud,syncing,admin:isAdmin(user),cleanupDuplicates,clearAllGames}}>
    <div style={shell}>
      <style>{GLOBAL_CSS}</style>
      <Header user={user} onLogout={LOGIN_ENABLED?logout:null} setTab={setTab} admin={isAdmin(user)}/>
      <div style={{padding:"14px 14px 0"}}>
        {tab==="home"&&<Home setTab={setTab} staleCount={staleCount} refreshStale={refreshStale} openGame={openGame}/>}
        {tab==="new"&&<NewGame setTab={setTab}/>}
        {tab==="players"&&<PlayersTab/>}
        {tab==="champ"&&<Championship/>}
        {tab==="courses"&&<CoursesTab/>}
        {tab==="settings"&&(isAdmin(user)?<SettingsTab/>:
          <Empty text="🔒 Réglages réservés à l'organisateur."/>)}
        {tab==="account"&&<AccountTab/>}
        {tab==="faq"&&<FaqTab/>}
        {tab==="history"&&<History openId={openGameId} onConsumeOpen={()=>setOpenGameId(null)}/>}
      </div>
      <TabBar tabs={tabs} tab={tab} setTab={setTab}/>
    </div>
    </Ctx.Provider>
  );
}

// RECONNEXION en 2 temps : (1) petite sécurité — saisis ton index / niveau de la DERNIÈRE
// connexion (sans le connaître, on n'entre pas sur le compte d'un autre) ; (2) confirme/ajuste
// ton niveau du JOUR (il sert uniquement aux coups rendus et doit refléter ton vrai niveau).
function SoftLogin({player,onOk,onCancel}){
  const ref=parseFloat(player.index)||0;
  const [step,setStep]=useState("check");
  const [val,setVal]=useState("");
  const [newIdx,setNewIdx]=useState(String(ref));
  const [err,setErr]=useState("");
  const check=()=>{
    if(val.trim()==="") return setErr("Saisis ton index / niveau de la dernière connexion.");
    if(Math.abs(parseFloat(val)-ref)<0.05){ setErr(""); setStep("update"); }
    else setErr("Niveau incorrect — c'est ton index / niveau de la dernière connexion (petite sécurité).");
  };
  const finish=()=>{
    const ni=parseFloat(newIdx);
    if(Number.isNaN(ni)) return setErr("Indique ton niveau du jour.");
    onOk(ni);
  };
  return (
    <div style={shell}><style>{GLOBAL_CSS}</style>
    <div style={{padding:"40px 24px"}}>
      <CrestLogo size={80}/>
      <div style={{fontFamily:"'Archivo',sans-serif",fontWeight:900,fontSize:22,marginTop:12}}>
        Content de te revoir, {dispName(player)} 👋</div>
      {step==="check" ? <>
        <div style={{fontSize:13,color:T.dim,marginTop:8,marginBottom:18,lineHeight:1.5}}>
          Petite sécurité : saisis ton <b style={{color:T.text}}>index / niveau de jeu de ta
          dernière connexion</b> pour confirmer que c'est bien toi.</div>
        <Field label="Index / niveau de la dernière connexion">
          <input type="number" step="0.1" value={val} autoFocus
            onChange={e=>setVal(e.target.value)} onKeyDown={e=>e.key==="Enter"&&check()}
            placeholder="ex: 15.4" style={inp}/></Field>
        {err&&<div style={{color:T.gold,fontSize:12,marginTop:8}}>{err}</div>}
        <button onClick={check} style={addBtn}>Confirmer</button>
      </> : <>
        <div style={{fontSize:13,color:T.accent,marginTop:8,fontWeight:800}}>✅ C'est bien toi !</div>
        <div style={{fontSize:13,color:T.dim,marginTop:6,marginBottom:18,lineHeight:1.5}}>
          Confirme ou ajuste ton <b style={{color:T.text}}>niveau du jour</b> (tu as peut-être
          progressé). Il sert uniquement à calculer tes <b style={{color:T.text}}>coups rendus</b>.</div>
        <Field label="Mon index / niveau aujourd'hui">
          <input type="number" step="0.1" value={newIdx} autoFocus
            onChange={e=>setNewIdx(e.target.value)} onKeyDown={e=>e.key==="Enter"&&finish()}
            style={inp}/></Field>
        {err&&<div style={{color:T.gold,fontSize:12,marginTop:8}}>{err}</div>}
        <button onClick={finish} style={addBtn}>Entrer</button>
      </>}
      <button onClick={onCancel} style={{...delBtn,width:"100%",marginTop:8,padding:"11px"}}>
        ← Ce n'est pas moi</button>
    </div></div>
  );
}

function WhoAreYou({members,loaded,cloud,games,courses,onPick,setMembers}){
  const [adding,setAdding]=useState(false);
  const [profileFor,setProfileFor]=useState(null); // joueur dont on complète la fiche
  const [verifyFor,setVerifyFor]=useState(null);   // joueur en reconnexion
  const [nm,setNm]=useState("");
  // Gagnants de la dernière Ryder (mis en avant) + nb de Ryder gagnées par joueur.
  const winners=useMemo(()=>lastRyderWinners(games,courses),[games,courses]);
  const wins=useMemo(()=>ryderWinsMap(games,courses),[games,courses]);
  // on n'affiche QUE les vrais profils : un invité jamais nommé n'est pas archivé/listé
  const realName=p=>p.name&&p.name.trim()&&p.name.trim().toLowerCase()!=="invité";
  const list=members.filter(realName).sort((a,b)=>dispName(a).localeCompare(dispName(b)));
  // Membres G&A = les joueurs préchargés (toujours en haut) ; les autres en dessous.
  const isMember=p=>p.member===true||/^seed-/.test(String(p.id));
  const isWinner=p=>winners.has(String(p.id));
  // Vainqueurs de la dernière Ryder ⭐ : groupe à part, tout en haut (membre OU invité).
  const pinTop=p=>/passe.?partout/i.test(dispName(p));
  const winnersList=list.filter(isWinner).sort((a,b)=>dispName(a).localeCompare(dispName(b)));
  const founders=list.filter(p=>isMember(p)&&!isWinner(p))
    .sort((a,b)=>(pinTop(a)===pinTop(b))?0:pinTop(a)?-1:1);
  const others=list.filter(p=>!isMember(p)&&!isWinner(p));
  const playerBtn=p=>{const win=isWinner(p);const nb=wins[String(p.id)]||0;return (
    <button key={p.id} onClick={()=>choose(p)} style={{display:"flex",alignItems:"center",
      gap:12,padding:"14px 16px",borderRadius:14,
      border:`1.5px solid ${win?T.gold:T.line}`,
      background:win?`${T.gold}1a`:T.panel,cursor:"pointer",textAlign:"left",color:T.text}}>
      <span style={{width:38,height:38,borderRadius:"50%",background:win?T.gold:T.accent,
        color:T.ink,display:"flex",alignItems:"center",justifyContent:"center",
        fontWeight:800,fontSize:16,flexShrink:0}}>
        {(dispName(p)[0]||"?").toUpperCase()}</span>
      <div style={{minWidth:0,flex:1}}>
        <div style={{fontWeight:800,fontSize:16,color:T.text,display:"flex",alignItems:"center",gap:6}}>
          {win&&<span title="Vainqueur de la dernière Ryder">🏆</span>}{dispName(p)}
          {nb>0&&<span style={{fontSize:10,color:T.gold,fontWeight:700}}>×{nb}</span>}</div>
        {p.name&&p.nick&&<div style={{fontSize:11,color:T.dim}}>{p.name}</div>}
      </div>
      {!p.profileDone&&<span style={{fontSize:10,color:T.gold,
        border:`1px solid ${T.gold}55`,borderRadius:999,padding:"2px 8px"}}>
        profil à compléter</span>}
    </button>);};
  const sectionLabel={fontSize:11,fontWeight:800,letterSpacing:1,textTransform:"uppercase",
    color:T.dim,margin:"14px 0 6px",textAlign:"left"};

  const enterAs=(p)=>onPick({id:p.id,name:p.name,nick:p.nick,email:p.email,
    mobile:p.mobile,index:p.index,player:true});
  // 1re connexion (profil pas encore complété) → on remplit sa fiche une fois pour toutes.
  // Reconnexion : on confirme juste l'identité + le niveau (pas de mot de passe).
  const choose=(p)=>{ if(p.profileDone) setVerifyFor(p); else setProfileFor(p); };
  // Identité confirmée : on met à jour l'index / niveau (pour les coups rendus) puis on entre
  const softOk=(p,newIndex)=>{
    const updated={...p,index:newIndex,profileDone:true};
    if(setMembers) setMembers(members.map(m=>m.id===p.id?updated:m));
    enterAs(updated);
  };

  if(verifyFor) return <SoftLogin player={verifyFor}
    onOk={(ni)=>softOk(verifyFor,ni)} onCancel={()=>setVerifyFor(null)}/>;
  if(profileFor) return <ProfileForm player={profileFor} cloud={cloud}
    onDone={(updated)=>{
      // on mémorise la fiche complétée (une fois pour toutes) avant d'entrer
      if(setMembers){ const exists=members.some(m=>m.id===updated.id);
        setMembers(exists?members.map(m=>m.id===updated.id?updated:m):[...members,updated]); }
      enterAs(updated); }}
    onCancel={()=>setProfileFor(null)}/>;

  return (
    <div style={shell}><style>{GLOBAL_CSS}</style>
    <div style={{padding:"44px 24px 40px",textAlign:"center"}}>
      <CrestLogo size={120}/>
      <div style={{fontFamily:"'Archivo',sans-serif",fontWeight:900,fontSize:28,lineHeight:1,
        letterSpacing:-1,marginTop:16}}>Du Golf <span style={{color:T.accent}}>&</span> des Amis</div>
      <div style={{color:T.accent,marginTop:8,fontSize:13,fontWeight:700}}>Joue, partage, kiffe</div>
      <div style={{marginTop:8,display:"inline-block",background:T.accent,
        color:"#06210f",fontWeight:800,fontSize:12,fontFamily:"monospace",
        padding:"3px 10px",borderRadius:999}}>
        {APP_VERSION}{cloud?" · ☁️ cloud":" · 📱 local"}</div>

      <div style={{marginTop:26,fontFamily:"'Archivo',sans-serif",fontWeight:800,
        fontSize:18,textAlign:"left"}}>Qui es-tu ?</div>
      <div style={{fontSize:12,color:T.dim,textAlign:"left",marginTop:2,marginBottom:14}}>
        Choisis ton nom pour entrer.</div>

      {!loaded && <div style={{color:T.dim,fontSize:13,padding:"20px 0"}}>Chargement…</div>}

      {loaded && list.length===0 && <div style={{color:T.dim,fontSize:13,
        padding:"16px",background:T.panel,borderRadius:12,textAlign:"left",lineHeight:1.5}}>
        Aucun joueur enregistré pour l'instant. Ajoute-toi ci-dessous.</div>}

      {loaded && winnersList.length>0 && <>
        <div style={{...sectionLabel,color:T.gold}}>🏆 Vainqueurs de la dernière Ryder</div>
        <div style={{display:"flex",flexDirection:"column",gap:8}}>{winnersList.map(playerBtn)}</div>
      </>}
      {loaded && founders.length>0 && <>
        <div style={sectionLabel}>★ Membres G&A</div>
        <div style={{display:"flex",flexDirection:"column",gap:8}}>{founders.map(playerBtn)}</div>
      </>}
      {loaded && others.length>0 && <>
        <div style={sectionLabel}>Autres joueurs</div>
        <div style={{display:"flex",flexDirection:"column",gap:8}}>{others.map(playerBtn)}</div>
      </>}

      {loaded && !adding && <button onClick={()=>setAdding(true)}
        style={{...delBtn,width:"100%",marginTop:12,padding:"12px",fontSize:13,
          borderColor:T.accent,color:T.accent}}>+ Je ne suis pas dans la liste</button>}

      {adding && <div style={{...card(T.accent),marginTop:12,textAlign:"left"}}>
        <div style={{fontWeight:800,marginBottom:8}}>Ton prénom pour commencer</div>
        <input value={nm} onChange={e=>setNm(e.target.value)} placeholder="Prénom" style={inp}/>
        <button disabled={!nm.trim()} onClick={()=>{
            const p={id:"p"+Date.now(),name:nm.trim(),nick:"",index:0,profileDone:false};
            setAdding(false);setProfileFor(p); // enchaîne sur le profil obligatoire
          }} style={{...addBtn,opacity:nm.trim()?1:.5}}>Continuer</button>
      </div>}
    </div></div>
  );
}

// Formulaire profil OBLIGATOIRE à la première connexion
function ProfileForm({player,cloud,onDone,onCancel}){
  const [name,setName]=useState(player.name||"");
  const [nick,setNick]=useState(player.nick||"");
  const [mobile,setMobile]=useState(player.mobile||"");
  const [email,setEmail]=useState(player.email||"");
  const [index,setIndex]=useState(player.index!=null?String(player.index):"");
  const [comm,setComm]=useState(player.comm||"whatsapp"); // whatsapp|email|both|none
  const [err,setErr]=useState("");
  const save=()=>{
    if(!name.trim()) return setErr("Indique ton prénom.");
    if(index==="") return setErr("Indique ton index / niveau de jeu.");
    const updated={...player,name:name.trim(),nick:nick.trim(),
      mobile:mobile.trim(),email:email.trim(),index:parseFloat(index)||0,
      comm,profileDone:true};
    if(cloud) upsertEntity("players",updated,null);
    onDone(updated);
  };
  return (
    <div style={shell}><style>{GLOBAL_CSS}</style>
    <div style={{padding:"40px 24px"}}>
      <CrestLogo size={80}/>
      <div style={{fontFamily:"'Archivo',sans-serif",fontWeight:900,fontSize:22,
        marginTop:12}}>Complète ton profil</div>
      <div style={{fontSize:12,color:T.dim,marginTop:4,marginBottom:18,lineHeight:1.5}}>
        Une seule fois, pour que tes parties et ton classement soient à ton nom.</div>

      <Field label="Prénom *"><input value={name} onChange={e=>setName(e.target.value)}
        placeholder="Prénom" style={inp}/></Field>
      <Field label="Surnom (affiché dans les parties)"><input value={nick}
        onChange={e=>setNick(e.target.value)} placeholder="ex: Trichatard" style={inp}/></Field>
      <Field label="Index / niveau de jeu *"><input type="number" step="0.1" value={index}
        onChange={e=>setIndex(e.target.value)} placeholder="ex: 18.4" style={inp}/></Field>
      <Field label="Mobile"><input type="tel" value={mobile}
        onChange={e=>setMobile(e.target.value)} placeholder="06 12 34 56 78" style={inp}/></Field>
      <Field label="Email"><input type="email" value={email}
        onChange={e=>setEmail(e.target.value)} placeholder="email" style={inp}/></Field>

      <div style={{marginTop:6}}>
        <PrefRow label="Notifications" value={comm} setValue={setComm}
          opts={[["whatsapp","WhatsApp"],["email","Email"],["both","Les 2"],["none","Aucune"]]}/>
      </div>

      {err&&<div style={{color:T.gold,fontSize:12,marginTop:8}}>{err}</div>}
      <button onClick={save} style={{...addBtn}}>Valider et entrer</button>
      <button onClick={onCancel} style={{...delBtn,width:"100%",marginTop:8,padding:"11px"}}>
        ← Retour</button>
    </div></div>
  );
}
// ligne de préférence en pilules
function PrefRow({label,value,setValue,opts}){
  return (
    <div style={{marginBottom:10}}>
      <div style={{fontSize:10,color:T.dim,textTransform:"uppercase",letterSpacing:.5,
        fontWeight:700,marginBottom:5}}>{label}</div>
      <div style={{display:"flex",gap:6}}>
        {opts.map(([v,l])=>(
          <button key={v} onClick={()=>setValue(v)} style={{flex:1,padding:"9px 6px",
            borderRadius:12,border:value===v?"none":`1.5px solid ${T.line}`,
            background:value===v?T.accent:"transparent",color:value===v?T.ink:T.text,
            fontWeight:800,fontSize:12,cursor:"pointer"}}>{l}</button>))}
      </div>
    </div>
  );
}

// "Mon compte" : chaque joueur met à jour SON profil (surnom, index, mobile, email, notif).
function AccountTab(){
  const {user,setUser,members,setMembers,games,courses}=useContext(Ctx);
  const me=members.find(m=>String(m.id)===String(user?.id))||user||{};
  const myRyderWins=ryderWinsMap(games,courses)[String(user?.id)]||0;
  const [name,setName]=useState(me.name||"");
  const [nick,setNick]=useState(me.nick||"");
  const [mobile,setMobile]=useState(me.mobile||"");
  const [email,setEmail]=useState(me.email||"");
  const [index,setIndex]=useState(me.index!=null?String(me.index):"");
  const [comm,setComm]=useState(me.comm||"whatsapp");
  const [saved,setSaved]=useState(false);
  const [err,setErr]=useState("");
  const save=()=>{
    if(!name.trim()) return setErr("Indique ton prénom.");
    if(index==="") return setErr("Indique ton index / niveau de jeu.");
    const updated={...me,id:user?.id??me.id,name:name.trim(),nick:nick.trim(),
      mobile:mobile.trim(),email:email.trim(),index:parseFloat(index)||0,comm,profileDone:true};
    const exists=members.some(m=>String(m.id)===String(updated.id));
    setMembers(exists?members.map(m=>String(m.id)===String(updated.id)?updated:m):[...members,updated]);
    setUser({...user,...updated});
    setErr(""); setSaved(true); setTimeout(()=>setSaved(false),1800);
  };
  return (
    <div>
      <Section>Mon compte</Section>
      <div style={{...card(T.gold),display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <span style={{fontWeight:800,fontSize:13}}>🏆 Ryder Cups gagnées</span>
        <span style={{fontFamily:"Anton",fontSize:24,color:T.gold}}>{myRyderWins}</span></div>
      <div style={{...card(T.gold),fontSize:12,color:T.dim,lineHeight:1.5}}>
        Mets à jour tes infos quand tu veux. Ton <b style={{color:T.text}}>index / niveau</b> sert
        uniquement à calculer tes <b style={{color:T.text}}>coups rendus</b> : tiens-le à jour
        pour qu'il reflète ton vrai niveau.</div>
      <Field label="Prénom"><input value={name} onChange={e=>setName(e.target.value)}
        placeholder="Prénom" style={inp}/></Field>
      <Field label="Surnom (affiché partout dans l'app)"><input value={nick}
        onChange={e=>setNick(e.target.value)} placeholder="ex: passe-partout" style={inp}/></Field>
      <Field label="Index / niveau de jeu *"><input type="number" step="0.1" value={index}
        onChange={e=>setIndex(e.target.value)} placeholder="ex: 15.4" style={inp}/></Field>
      <Field label="Mobile"><input type="tel" value={mobile}
        onChange={e=>setMobile(e.target.value)} placeholder="06 12 34 56 78" style={inp}/></Field>
      <Field label="Email"><input type="email" value={email}
        onChange={e=>setEmail(e.target.value)} placeholder="email" style={inp}/></Field>
      <div style={{marginTop:6}}>
        <PrefRow label="Préférence de communication" value={comm} setValue={setComm}
          opts={[["whatsapp","WhatsApp"],["email","Email"],["both","Les 2"],["none","Aucune"]]}/>
      </div>
      {err&&<div style={{color:T.gold,fontSize:12,marginTop:8}}>{err}</div>}
      <button onClick={save} style={{...addBtn,background:saved?T.gold:T.accent,
        color:saved?"#1a1200":"#04150b"}}>{saved?"✅ Enregistré":"Enregistrer mes infos"}</button>
    </div>
  );
}

// "Comment ça marche" : présentation + FAQ, accessible à tous (onboarding des potes).
function FaqTab(){
  const groups=[
    ["🚀 Démarrer",[
      ["👋 Première connexion","Sur l'accueil « Qui es-tu ? », tape sur ton prénom. À ta 1re fois, tu remplis ta fiche UNE seule fois (surnom, index / niveau de jeu, mobile, email). C'est tout."],
      ["🔑 Te reconnecter","Les fois suivantes : tape ton prénom → saisis ton index / niveau de ta DERNIÈRE connexion (petite sécurité : sans le connaître, on n'entre pas sur le compte d'un autre) → puis ajuste ton niveau du jour. ⚠️ L'index n'est PAS un mot de passe : son seul rôle est de calculer les coups rendus, garde-le fidèle à ton vrai niveau."],
      ["🔔 Rejoindre une partie en cours","Si tu te connectes alors qu'une partie où tu es inscrit n'est pas terminée, l'accueil te propose de la REJOINDRE en un clic (ou « Plus tard »)."],
      ["⏲️ Déconnexion auto","L'appli te déconnecte (retour à « Qui es-tu ? ») quand tu QUITTES l'appli, ou après un long moment d'inactivité — mais JAMAIS pendant une partie en cours : tu peux scorer tout ton round tranquille."],
      ["👤 Mon compte","Bouton 👤 en haut : change ton surnom, ton index / niveau, ton mobile, ton email ou ta notif. Tu ne modifies que TA fiche (les autres, c'est l'organisateur)."],
    ]],
    ["⛳ Jouer une partie",[
      ["➕ Lancer une partie","Onglet Nouvelle : Partie amicale (2-4 joueurs) ou Tournoi. Tu choisis le Parcours, les joueurs, la Formule et le Décompte (Brut ou Net, + case « différentiel » pour le match play). Le NOM est automatique (formule + brut/net + date + heure). Tout le monde peut jouer (membres + invités)."],
      ["👥 Membres & invités","Les membres G&A restent en pastilles. Les anciens invités sont rangés dans une liste déroulante « + Ajouter un ancien invité » pour ne pas encombrer. Tu peux aussi créer un invité à la volée."],
      ["🤝 Les équipes (2 contre 2)","Pour une formule 2v2 (Fourball, Mexicaine, Scramble, Foursome, Match Play 2v2), une section « Les équipes » te fait désigner qui joue avec qui : Équipe 1 / Équipe 2 (2 joueurs chacune)."],
      ["✍️ Le scoreur","Dans chaque partie on désigne qui « tient la carte » (le scoreur). À plusieurs parties en parallèle, chacune a SON scoreur ; lui seul saisit les scores."],
      ["👀 Suivre en direct","Les autres ouvrent la même partie et suivent le score en lecture seule. Le tableau se met à jour À CHAQUE TROU VALIDÉ → tout le monde voit l'avancement en temps réel, sans attendre la fin."],
      ["🗺️ Les parcours","15 parcours préchargés. Chacun peut en CRÉER (recherche GolfCourseAPI ou saisie à la main) et CORRIGER un par / HCP / slope inexact (mémorisé pour toujours) — soyez rigoureux 🙏. Seul l'organisateur peut SUPPRIMER un parcours."],
    ]],
    ["🎮 Les formules de jeu",[
      ["🎯 2 niveaux de points","Deux choses distinctes : (1) le RÉSULTAT de la partie — qui gagne, dans le langage de la formule ; (2) les POINTS DE SAISON — un système de DUELS identique pour TOUTES les formules, qui alimente le classement. Une partie non validée = 0 point. (Net = brut − coups rendus.)"],
      ["👥 À 2 joueurs","• Match Play 1v1 : le net le plus bas gagne le trou → statut 1 UP / All Square / 2&1, mis à jour après chaque trou. • Stroke Play net : plus petit total de coups nets. • Stableford (net ou brut) : eagle 4 · birdie 3 · par 2 · bogey 1 · double+ 0. • Skins : 1 pt/trou au net le plus bas ; égalité → le point se REPORTE au trou suivant."],
      ["👥 À 3 joueurs","• Chouette (6 pts/trou) selon les 3 nets : 4/2/0 si tous différents · 3/3/0 (égalité 1er) · 4/1/1 (égalité 2e) · 2/2/2 (les 3 à égalité). • 1v1v1 : le net le plus bas du trou prend 1 pt (partagé si égalité). • Stableford et Skins : comme à 2."],
      ["👥👥 À 4 joueurs (2 contre 2)","Les FOURBALL comparent la meilleure balle nette de chaque équipe, trou par trou → statut 1 UP / All Square / 2&1. • Fourball (meilleure balle) : chacun sa balle. • Fourball — meilleure & moins bonne : 2 pts/trou (1 pt meilleure balle + 1 pt moins bonne), on cumule. • Foursome / Greensome : une balle, coups alternés. • Scramble : on repart toujours de la meilleure position. • Chamble : chacun sa balle SAUF le drive (toute l'équipe repart du meilleur coup de départ). • Mexicaine (brut) : points cumulés (par+par +5, 2 birdies +10, inversion par birdie adverse), expliqués dans « Faits de jeu »."],
    ]],
    ["🏅 Le championnat",[
      ["🏅 Les points de saison (duels)","On compte les DUELS (qui bat qui) : 1v1 → Victoire 3 · Nul 1 · Défaite 0. À 3 → 2 duels (V 2) : battre les 2 = 4. Double 2v2 → V 3 chacun. Indépendant de la formule de jeu."],
      ["⚖️ Qui compte au classement ?","Tout le monde peut jouer (invités compris), mais une confrontation ne RAPPORTE des points de saison que s'il y a AU MOINS 2 membres G&A dedans. Sinon la partie se joue normalement mais reste « hors classement » (c'est indiqué en fin de partie)."],
      ["🏆 Les modes de tournoi","Onglet Nouvelle → Tournoi, 3 modes : • 🏆 RYDER CUP : 2 équipes, tirage en chapeaux de 2 (par index), confrontations équilibrées proposées et formules variées par manche, scoreboard façon EUR-USA. On est SOLIDAIRES (on gagne/perd ensemble). • 🥊 MINICUP : élimination directe en 1v1, tirage aléatoire, le gagnant avance jusqu'à la finale (format des duels choisi à la création). • 🏅 MINICHAMP : Intégral (cumul de points sur les manches, +5 au vainqueur) — les Poules arrivent bientôt."],
      ["📊 Deux classements","« Cumulé » (qui joue plus marque plus) et « Moyenne par partie » (pour que ceux qui jouent peu aient leur chance). + le bilan des confrontations directes entre potes."],
    ]],
    ["📲 Communication & réglages",[
      ["💬 Partage WhatsApp","À la validation du 18e trou : le résultat de la formule + une fiche par joueur (médaille + Stableford BRUT et NET) + l'évolution au classement (points gagnés, rang, ▲/▼ places). Tu partages tout au groupe en un clic. Si la partie ne compte pas (moins de 2 membres), c'est précisé."],
      ["🔒 Droits & réglages","Le menu ⚙️ (clé parcours, lien du groupe WhatsApp) est réservé à l'organisateur. Lui seul peut aussi modifier la fiche d'un autre joueur et supprimer un parcours. Les autres : ils créent / corrigent les parcours et gèrent LEUR propre fiche."],
    ]],
  ];
  const [open,setOpen]=useState(0); // accordéon : index de rubrique ouverte (-1 = toutes fermées)
  return (
    <div>
      <Section>Comment ça marche</Section>
      <div style={{...card(T.accent),fontSize:13,color:T.text,lineHeight:1.5,marginBottom:12}}>
        Bienvenue chez <b>Du Golf & des Amis</b> ⛳ — l'appli pour jouer, scorer en direct et
        suivre le classement entre potes. <b>Touche une rubrique pour la déplier.</b></div>
      {groups.map(([title,items],gi)=>{
        const isOpen=open===gi;
        return (
          <div key={gi} style={{marginBottom:8}}>
            <div onClick={()=>setOpen(isOpen?-1:gi)} style={{...card(T.line),cursor:"pointer",
              marginBottom:isOpen?6:0,display:"flex",justifyContent:"space-between",
              alignItems:"center",background:isOpen?`${T.accent}14`:T.panel,
              border:`1.5px solid ${isOpen?T.accent+"66":T.line}`}}>
              <span style={{fontWeight:800,fontSize:15}}>{title}</span>
              <span style={{color:isOpen?T.accent:T.dim,fontSize:13}}>
                {isOpen?"▾ fermer":`▸ ${items.length}`}</span>
            </div>
            {isOpen && items.map(([t,d],i)=>(
              <div key={i} style={{...card(T.line),marginBottom:6,marginLeft:6}}>
                <div style={{fontWeight:800,marginBottom:4,fontSize:14}}>{t}</div>
                <div style={{fontSize:13,color:T.dim,lineHeight:1.5}}>{d}</div>
              </div>))}
          </div>
        );
      })}
      <div style={{fontSize:11,color:T.dim,textAlign:"center",marginTop:10,marginBottom:20}}>
        Une question en plus ? Demande à l'organisateur 😉</div>
    </div>
  );
}

function Header({user,onLogout,setTab,admin}){
  return (
    <div style={{padding:"22px 18px 14px",position:"relative",overflow:"hidden",
      borderBottom:`1px solid ${T.line}`,
      background:`radial-gradient(120% 100% at 0% 0%, ${T.accent}14 0%, transparent 55%), ${T.bg}`,
      display:"flex",justifyContent:"space-between",alignItems:"flex-end"}}>
      <div style={{display:"flex",alignItems:"center",gap:11}}>
        <CrestLogo size={44}/>
        <div>
          <div style={{fontFamily:"'Archivo',sans-serif",fontWeight:900,fontSize:18,
            lineHeight:.95,letterSpacing:-.5}}>
            Du Golf <span style={{color:T.accent}}>&</span> des Amis</div>
          <div style={{fontSize:11,color:T.dim,marginTop:3,fontWeight:600,letterSpacing:.3}}>
            {onLogout?`Salut ${user.nick?.trim()||user.name} 👋`:"Joue, partage, kiffe"}</div></div></div>
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        {setTab&&<button onClick={()=>setTab("faq")} title="Comment ça marche"
          style={{...delBtn,fontSize:14,padding:"7px 10px"}}>❔</button>}
        {setTab&&onLogout&&<button onClick={()=>setTab("account")} title="Mon compte"
          style={{...delBtn,fontSize:14,padding:"7px 10px"}}>👤</button>}
        {setTab&&admin&&<button onClick={()=>setTab("settings")} title="Réglages"
          style={{...delBtn,fontSize:14,padding:"7px 10px"}}>⚙️</button>}
        {onLogout && <button onClick={onLogout} style={{...delBtn,fontSize:11}}>Déconnexion</button>}
      </div>
    </div>
  );
}
function TabBar({tabs,tab,setTab}){
  return (<div style={tabbar}>{tabs.map(([k,l,i])=>(
    <button key={k} onClick={()=>setTab(k)} style={{...tabBtn,color:tab===k?T.accent:T.dim}}>
      <span style={{fontSize:20}}>{i}</span><span style={{fontSize:10,fontWeight:700}}>{l}</span>
    </button>))}</div>);
}

function Home({setTab,staleCount,refreshStale,openGame}){
  const {games,user,admin}=useContext(Ctx);
  // ouvrir WhatsApp si le lien existe ; sinon seul l'organisateur va aux Réglages
  const goWa=()=>waLink?window.open(waLink,"_blank")
    :(admin?setTab("settings"):alert("Le lien du groupe WhatsApp sera ajouté par l'organisateur."));
  const ongoing=games.filter(g=>!g.done);
  const done=games.filter(g=>g.done);
  const prenom=dispName(user)||"toi"; // surnom complet (ex: "passe partout"), plus tronqué
  const waLink=DB.lget("waGroup",DEFAULT_WA);
  // partie EN COURS où je suis inscrit → on propose de la rejoindre
  const [hideJoin,setHideJoin]=useState(false);
  const myLive=ongoing.find(g=>(g.roster||[]).some(p=>String(p.id)===String(user?.id)));
  return (
    <div>
      {myLive && !hideJoin && (
        <div style={{...card(T.accent),marginBottom:14,
          background:`linear-gradient(160deg, ${T.accent}22 0%, ${T.panel} 60%)`}}>
          <div style={{fontWeight:800,marginBottom:2}}>🔔 Une partie est en cours</div>
          <div style={{fontSize:12,color:T.dim,marginBottom:10}}>
            Tu es inscrit à <b style={{color:T.text}}>{myLive.name}</b>. Tu veux la rejoindre ?</div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>openGame&&openGame(myLive.id)}
              style={{...addBtn,margin:0,flex:1}}>✅ Rejoindre</button>
            <button onClick={()=>setHideJoin(true)}
              style={{...delBtn,padding:"11px 14px"}}>Plus tard</button>
          </div>
        </div>
      )}
      <div style={{margin:"6px 0 18px"}}>
        <div style={{fontFamily:"'Archivo',sans-serif",fontWeight:900,fontSize:25,
          lineHeight:1.05,letterSpacing:-.5}}>
          Prêt à jouer, <span style={{color:T.accent}}>{prenom}</span> ?</div>
        <div style={{color:T.dim,fontSize:13,marginTop:6}}>
          Lance une partie, suis le score en direct, partage les résultats.</div>
      </div>

      {staleCount>0&&<div onClick={refreshStale} style={{...card(T.gold),cursor:"pointer",
        display:"flex",alignItems:"center",gap:12,
        background:`linear-gradient(160deg, ${T.gold}22 0%, ${T.panel} 60%)`}}>
        <span style={{fontSize:26}}>🔄</span>
        <div><div style={{fontWeight:800}}>{staleCount} parcours à actualiser</div>
          <div style={{fontSize:11,color:T.dim}}>Données de plus de 6 mois — tape pour mettre à jour</div></div></div>}

      {/* Deux cartes d'action principales */}
      <div style={{display:"flex",gap:12,marginTop:4}}>
        <ActionCard color={T.accent} icon="⛳" title="Partie amicale"
          sub="2 à 4 joueurs · entre potes"
          onClick={()=>{DB.lset("newType","simple");setTab("new");}}/>
        <ActionCard color={T.gold} icon="🏆" title="Tournoi / Ryder"
          sub="5+ joueurs · équipes & manches"
          onClick={()=>{DB.lset("newType","event");setTab("new");}}/>
      </div>

      {ongoing.length>0&&<><Section>En cours</Section>
        {ongoing.map(g=><div key={g.id} onClick={()=>setTab("history")}
          style={{...card(T.gold),cursor:"pointer",
          background:`linear-gradient(160deg, ${T.gold}1a 0%, ${T.panel} 60%)`}}>
          <div style={{fontWeight:800}}>▶ {g.name}</div>
          <div style={{fontSize:11,color:T.dim}}>
            {g.subtype==="ryder"?"Ryder Cup":g.subtype==="coupe"?"MiniCup":g.type==="event"?"MiniChamp":"Partie amicale"} ·
            {g.rounds?` ${g.rounds.length} manche(s)`:` ${g.subgames?.length||1} match(s)`} · en cours</div></div>)}</>}

      <Section>Raccourcis</Section>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
        <Tile color={T.accent} icon="🏌️" title="Parties"
          sub={`${ongoing.length} en cours · ${done.length} terminées`}
          onClick={()=>setTab("history")}/>
        <Tile color={T.gold} icon="🏅" title="Classement"
          sub="Championnat & confrontations" onClick={()=>setTab("champ")}/>
        <Tile color="#25D366" icon="💬" title="Chat du groupe"
          sub={waLink?"Ouvrir WhatsApp":"À configurer (Réglages)"}
          onClick={goWa}/>
        <Tile color={T.eu} icon="⛳" title="Parcours"
          sub="Gérer / importer" onClick={()=>setTab("courses")}/>
      </div>

      <div style={{display:"flex",flexDirection:"column",alignItems:"center",
        margin:"30px 0 10px",opacity:.9}}>
        <CrestLogo size={92}/>
        <div style={{fontFamily:"'Archivo',sans-serif",fontWeight:800,fontSize:14,
          marginTop:10,letterSpacing:.3,color:T.dim}}>
          Du Golf <span style={{color:T.accent}}>&</span> des Amis</div>
        <div style={{marginTop:8,display:"inline-block",background:T.accent,
          color:"#06210f",fontWeight:800,fontSize:12,fontFamily:"monospace",
          padding:"3px 10px",borderRadius:999}}>
          {APP_VERSION}{supabaseEnabled?" · ☁️ cloud":" · 📱 local"}</div>
      </div>
    </div>
  );
}
// carte d'action principale, compacte (icône + texte côte à côte)
function ActionCard({color,icon,title,sub,onClick}){
  return (<div onClick={onClick} style={{flex:1,borderRadius:20,padding:"18px 16px",
    cursor:"pointer",border:`1.5px solid ${color}55`,
    background:`linear-gradient(160deg, ${color}26 0%, ${T.panel} 70%)`,
    boxShadow:`0 6px 22px ${color}14`,transition:"transform .12s"}}
    onMouseDown={e=>e.currentTarget.style.transform="scale(.97)"}
    onMouseUp={e=>e.currentTarget.style.transform="scale(1)"}
    onMouseLeave={e=>e.currentTarget.style.transform="scale(1)"}>
    <div style={{fontSize:40,lineHeight:1}}>{icon}</div>
    <div style={{fontFamily:"'Archivo',sans-serif",fontWeight:800,fontSize:18,
      marginTop:12,letterSpacing:-.3,lineHeight:1.1}}>{title}</div>
    <div style={{fontSize:11,color:T.dim,marginTop:5,lineHeight:1.4}}>{sub}</div></div>);
}
// logo écusson G&A (inline SVG, & en vert fairway)
function CrestLogo({size=92}){
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
      <path d="M256 64 L420 116 V268 C420 360 348 418 256 452 C164 418 92 360 92 268 V116 Z"
        fill="#101a14" stroke={T.accent} strokeWidth="12"/>
      <path d="M256 96 L392 139 V262 C392 338 332 387 256 416 C180 387 120 338 120 262 V139 Z"
        fill="none" stroke={T.accent} strokeWidth="2.5" opacity="0.4"/>
      <text x="256" y="250" fontFamily="Georgia, 'Times New Roman', serif" fontWeight="700"
        fontSize="150" fill={T.text} textAnchor="middle">G</text>
      <text x="256" y="332" fontFamily="Georgia, serif" fontStyle="italic" fontWeight="700"
        fontSize="120" fill={T.accent} textAnchor="middle">&amp;</text>
      <text x="256" y="414" fontFamily="Georgia, 'Times New Roman', serif" fontWeight="700"
        fontSize="110" fill={T.text} textAnchor="middle">A</text>
    </svg>
  );
}
// tuile de raccourci (grille 2 colonnes)
function Tile({color,icon,title,sub,onClick}){
  return (<div onClick={onClick} style={{borderRadius:18,padding:"14px",height:112,
    boxSizing:"border-box",cursor:"pointer",border:`1.5px solid ${color}55`,
    background:`linear-gradient(160deg, ${color}1c 0%, ${T.panel} 70%)`,
    display:"flex",flexDirection:"column",justifyContent:"flex-start",gap:8}}>
    <span style={{fontSize:26,lineHeight:1,height:30}}>{icon}</span>
    <div style={{minWidth:0}}>
      <div style={{fontWeight:800,fontSize:15,lineHeight:1.15}}>{title}</div>
      <div style={{fontSize:11,color:T.dim,lineHeight:1.3,marginTop:3,
        overflow:"hidden",textOverflow:"ellipsis"}}>{sub}</div></div></div>);
}
function BigCard({color,icon,title,sub,onClick}){
  return (<div onClick={onClick} style={{flex:1,borderRadius:22,padding:20,
    cursor:"pointer",border:`1.5px solid ${color}55`,
    background:`linear-gradient(160deg, ${color}24 0%, ${T.panel} 65%)`,
    transition:"transform .12s",display:"flex",flexDirection:"column",
    justifyContent:"space-between",boxShadow:`0 8px 30px ${color}14`}}
    onMouseDown={e=>e.currentTarget.style.transform="scale(.97)"}
    onMouseUp={e=>e.currentTarget.style.transform="scale(1)"}
    onMouseLeave={e=>e.currentTarget.style.transform="scale(1)"}>
    <div style={{fontSize:54,lineHeight:1}}>{icon}</div>
    <div>
      <div style={{fontFamily:"'Archivo',sans-serif",fontWeight:800,fontSize:21,
        marginTop:10,letterSpacing:-.3,lineHeight:1.05}}>{title}</div>
      <div style={{fontSize:12,color:T.dim,marginTop:6,lineHeight:1.4}}>{sub}</div>
    </div></div>);
}

function NewGame({setTab}){
  const {members,setMembers,courses,setCourses,games,setGames}=useContext(Ctx);
  const [type,setType]=useState(DB.lget("newType","simple"));
  const [subtype,setSubtype]=useState("simple"); // tournoi : 'simple' | 'ryder' | 'coupe'
  const [coupeFormula,setCoupeFormula]=useState("matchplay"); // format des duels d'une coupe
  const [name,setName]=useState("");
  // Parcours par défaut = Nans (parcours « maison ») ; on pourra le remplacer d'un clic.
  const [courseId,setCourseId]=useState(()=>courses.find(c=>/Nans/i.test(c.name||""))?.id);
  const [isTest,setIsTest]=useState(false); // partie de TEST → exclue du classement
  const [mode,setMode]=useState("net");
  const [hcpRelative,setHcpRelative]=useState(false); // coups rendus différentiel (match play)
  const [selected,setSelected]=useState([]);
  const [guests,setGuests]=useState([]);
  const [tees,setTees]=useState({});
  const [over,setOver]=useState({});  // overrides {playerId:{index}} ajustables pour la partie
  const [split,setSplit]=useState(null);          // amicale >4 : répartition en flights
  const [flightOf,setFlightOf]=useState({});       // amicale >4 : id joueur -> n° de flight
  const [formula,setFormula]=useState(null);
  const [teamOf,setTeamOf]=useState({}); // 2v2 : id joueur -> 0 (Équipe 1) ou 1 (Équipe 2)
  // Tournoi multi-manches : chaque manche a SON parcours ET SA répartition (formules)
  const [rounds,setRounds]=useState([{courseId:courses[0]?.id,split:null}]);
  const addRound=()=>setRounds([...rounds,{courseId:courses[0]?.id,
    split:n>=2?autoSplit(n):null}]);
  const updRound=(i,cid)=>setRounds(rounds.map((r,j)=>j===i?{...r,courseId:cid}:r));
  const delRound=i=>setRounds(rounds.filter((_,j)=>j!==i));
  const setRoundSplit=(i,sp)=>setRounds(rounds.map((r,j)=>j===i?{...r,split:sp}:r));

  const refCourseId=type==="event"?(rounds[0]?.courseId):courseId;
  const course=courses.find(c=>c.id===refCourseId);
  const teeNames=(course?.tees||[]).map(t=>t.name);
  const defaultTee=teeNames[0]||"";
  const allPlayers=[...members.filter(m=>selected.includes(m.id)),...guests];
  const n=allPlayers.length;

  const toggle=id=>setSelected(selected.includes(id)?selected.filter(x=>x!==id):[...selected,id]);
  const addGuest=()=>setGuests([...guests,{id:"g"+Date.now(),guest:true,name:"Invité",
    index:20}]);
  const updGuest=(id,k,v)=>setGuests(guests.map(g=>g.id===id?{...g,[k]:v}:g));
  const delGuest=id=>setGuests(guests.filter(g=>g.id!==id));
  const setTee=(pid,t)=>setTees({...tees,[pid]:t});
  const getTee=pid=>tees[pid]||defaultTee;
  // index de jeu réel ajustable pour CETTE partie (défaut = valeur de la fiche)
  const getIndex=p=>over[p.id]?.index!==undefined?over[p.id].index:p.index;
  const setOverride=(pid,k,v)=>setOver({...over,[pid]:{...over[pid],[k]:v}});
  // Membres G&A (toujours en chips) vs anciens invités/non-membres (liste déroulante)
  const isFounder=m=>m.member===true||/^seed-/.test(String(m.id));
  const others=members.filter(m=>!isFounder(m));

  const simpleFormulas=n>=2&&n<=4?formulasFor(n):[];
  useEffect(()=>{if(simpleFormulas.length&&!simpleFormulas.includes(formula))
    setFormula(simpleFormulas[0]);},[n]);// eslint-disable-line
  // Mexicaine = toujours en brut : on force le mode (le 2e menu est masqué)
  const brutOnly=type==="simple"&&BRUT_ONLY.includes(formula);
  useEffect(()=>{if(brutOnly)setMode("gross");},[brutOnly]);// eslint-disable-line
  // === Équipes 2 contre 2 : qui joue avec qui ===
  const team2v2=type==="simple" && n===4 && TEAM_2V2.includes(formula);
  const getTeam=(id,idx)=> teamOf[id]!==undefined ? teamOf[id] : (idx<2?0:1); // défaut : 2 premiers vs 2 derniers
  const setTeam=(id,t)=>setTeamOf(o=>({...o,[id]:t}));
  // quand l'effectif change, (ré)initialise la répartition de chaque manche
  useEffect(()=>{if(type==="event"&&n>=2)
    setRounds(rs=>rs.map(r=>({...r,split:autoSplit(n)})));},[n,type]);// eslint-disable-line
  // amicale à PLUS de 4 joueurs : on prépare une répartition par défaut (et on réinitialise
  // l'affectation des joueurs quand la config ou l'effectif change).
  useEffect(()=>{ if(type==="simple"&&n>4){ setSplit(autoSplit(n)); setFlightOf({}); } },[n,type]);// eslint-disable-line
  // affectation par défaut des joueurs aux flights (séquentielle), surchargée par flightOf
  const multiSplit=type==="simple"&&n>4?(split||autoSplit(n)):null;
  const defaultFlight=useMemo(()=>{ const m={}; if(multiSplit){ let idx=0;
    multiSplit.forEach((grp,gi)=>{ for(let k=0;k<grp.size;k++){ const p=allPlayers[idx++]; if(p)m[p.id]=gi; } }); }
    return m; },[multiSplit,allPlayers.map(p=>p.id).join(",")]);// eslint-disable-line
  const flightOfP=p=> flightOf[p.id]!==undefined ? flightOf[p.id] : (defaultFlight[p.id]??0);
  const flightCount=gi=> allPlayers.filter(p=>flightOfP(p)===gi).length;

  // Nom AUTO-DÉDUIT : mode de jeu + brut/net + date + heure (plus de saisie libre).
  const finalName=()=>{
    const d=new Date(),z=n=>String(n).padStart(2,"0");
    const when=`${z(d.getDate())}/${z(d.getMonth()+1)}/${String(d.getFullYear()).slice(2)} · ${z(d.getHours())}h${z(d.getMinutes())}`;
    const what=type==="event"?(subtype==="ryder"?"Ryder Cup":subtype==="coupe"?"MiniCup":"MiniChamp")
      :(type==="simple"&&n>4)?`${(split||autoSplit(n)).length} parties`:(FORMULA_SHORT[formula]||"Partie");
    const nb=brutOnly?"brut":(mode==="gross"?"brut":"net"); // l'info brut/net reste dans le titre
    return `${what} ${nb} · ${when}`;
  };

  const create=()=>{
    if(type==="simple" && !courseId) return alert("Choisis d'abord un parcours.");
    if(subtype==="poule") return alert("Le mode Poules arrive très vite 🙏 — choisis « Intégral » pour l'instant.");
    if(n<2)return alert("Au moins 2 joueurs.");
    // On n'archive un invité comme joueur permanent QUE s'il a saisi un VRAI prénom
    // (différent de "Invité") ET un index. Un invité jamais nommé est oublié, pas archivé.
    const realName=g=>g.name&&g.name.trim()&&g.name.trim().toLowerCase()!=="invité";
    const keepers=guests.filter(g=>realName(g)&&(parseFloat(g.index)||0)>0)
      .map(g=>({id:g.id,name:g.name.trim(),nick:g.nick?.trim()||"",
        index:parseFloat(g.index)||0,profileDone:false,guest:false}));
    if(keepers.length){
      const existingIds=new Set(members.map(m=>m.id));
      const toAdd=keepers.filter(k=>!existingIds.has(k.id));
      if(toAdd.length) setMembers([...members,...toAdd]);
    }
    // 2v2 : on classe les joueurs par équipe (Équipe 1 puis Équipe 2) pour le calcul
    let ordered=allPlayers;
    if(team2v2){
      const t0=allPlayers.filter((p,i)=>getTeam(p.id,i)===0);
      const t1=allPlayers.filter((p,i)=>getTeam(p.id,i)===1);
      if(t0.length!==2||t1.length!==2) return alert("Forme 2 équipes de 2 joueurs.");
      ordered=[...t0,...t1];
    }
    const roster=ordered.map((p,i)=>({...p,tee:getTee(p.id),
      index:getIndex(p),
      team:type==="event"?null:(team2v2?(i<2?0:1):undefined)}));
    if(type==="simple"){
      if(n<=4){
        const ids=roster.map(p=>p.id);
        const subgames=[{id:1,formula,players:ids,scores:{},validated:[],done:false,hcpRelative}];
        const game={id:Date.now(),name:finalName(),type,courseId,mode,roster,subgames,test:isTest,
          hcpRelative,teamNames:team2v2?["Équipe 1","Équipe 2"]:null,done:false,created:Date.now()};
        setGames([game,...games]);setTab("history");return;
      }
      // PLUS de 4 joueurs : plusieurs parties (flights) selon la configuration choisie
      const sp=split||autoSplit(n);
      const flights=sp.map((grp,gi)=>({grp,gi,players:roster.filter(p=>flightOfP(p)===gi)}));
      const bad=flights.find(f=>f.players.length!==f.grp.size);
      if(bad) return alert(`Configuration incomplète : la partie ${bad.gi+1} doit compter ${bad.grp.size} joueurs (actuellement ${bad.players.length}). Ajuste l'affectation des joueurs.`);
      const subgames=flights.map((f,i)=>({id:i+1,formula:f.grp.formula,
        players:f.players.map(p=>p.id),scores:{},validated:[],done:false,hcpRelative}));
      const game={id:Date.now(),name:finalName(),type,courseId,mode,roster,subgames,test:isTest,
        hcpRelative,teamNames:null,done:false,created:Date.now()};
      setGames([game,...games]);setTab("history");return;
    }
    if(subtype==="coupe"){
      if(!courseId) return alert("Choisis d'abord un parcours.");
      // bracket vide : le tirage du tour 1 se lance dans le détail
      const game={id:Date.now(),name:finalName(),type:"event",subtype:"coupe",mode,courseId,test:isTest,
        coupeFormula,roster,rounds:[],hcpRelative,teamNames:null,done:false,created:Date.now()};
      setGames([game,...games]);setTab("history");return;
    }
    // TOURNOI : chaque manche a SON parcours + SA répartition (formules choisies à la main)
    const tRounds=(rounds.length?rounds:[{courseId,split:null}]).map((r,ri)=>{
      const c=courses.find(x=>x.id===r.courseId);
      let pool=[...roster];let i=1;const subgames=[];
      (r.split||autoSplit(n)).forEach(grp=>{const gp=pool.splice(0,grp.size);
        const ids=gp.map(p=>p.id);
        subgames.push({id:i++,formula:grp.formula,players:ids,
          scores:{},validated:[],done:false,hcpRelative});});
      return {id:ri+1,courseId:r.courseId,courseName:c?.name||"Parcours",
        subgames,done:false};
    });
    const game={id:Date.now(),name:finalName(),type,subtype,mode,roster,rounds:tRounds,test:isTest,
      hcpRelative,teamNames:["Équipe 1","Équipe 2"],done:false,created:Date.now()};
    setGames([game,...games]);setTab("history");
  };

  // 2e menu : brut/net + case « différentiel ». Réutilisé pour partie simple et tournoi.
  const decompteUI=(<>
    <Field label="Brut ou Net ?"><select value={mode} onChange={e=>setMode(e.target.value)}
      style={inp}><option value="net">Net (coups rendus)</option>
      <option value="gross">Brut</option></select></Field>
    {mode==="net" && (
      <div onClick={()=>setHcpRelative(v=>!v)} style={{...card(hcpRelative?T.accent:T.line),
        cursor:"pointer",display:"flex",gap:10,alignItems:"flex-start",marginTop:2}}>
        <div style={{width:22,height:22,borderRadius:6,flexShrink:0,marginTop:1,
          border:`2px solid ${hcpRelative?T.accent:T.line}`,
          background:hcpRelative?T.accent:"transparent",color:T.ink,
          display:"flex",alignItems:"center",justifyContent:"center",
          fontWeight:900,fontSize:14}}>{hcpRelative?"✓":""}</div>
        <div>
          <div style={{fontWeight:800,fontSize:13}}>Coups rendus en différentiel (match play)</div>
          <div style={{fontSize:11,color:T.dim,marginTop:2,lineHeight:1.4}}>
            Coché : on rend l'<b>écart</b> entre joueurs sur les trous les plus durs
            (le plus bas joue à 0). Décoché : chacun reçoit son total complet (stroke play).</div>
        </div>
      </div>
    )}
  </>);

  return (
    <div>
      <Section>{type==="simple"?"Nouvelle partie amicale":"Nouveau tournoi"}</Section>
      <div style={{display:"flex",gap:8,marginBottom:8}}>
        <Pill active={type==="simple"} onClick={()=>setType("simple")}>Partie amicale</Pill>
        <Pill active={type==="event"} onClick={()=>setType("event")}>Tournoi</Pill>
      </div>
      {type==="event"&&<div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:8}}>
        <Pill active={subtype==="ryder"} onClick={()=>setSubtype("ryder")}>🏆 Ryder Cup</Pill>
        <Pill active={subtype==="coupe"} onClick={()=>setSubtype("coupe")}>🥊 MiniCup</Pill>
        <Pill active={subtype==="simple"||subtype==="poule"} onClick={()=>setSubtype("simple")}>🏅 MiniChamp</Pill>
      </div>}
      {type==="event"&&(subtype==="simple"||subtype==="poule")&&
        <div style={{display:"flex",gap:8,marginBottom:8}}>
          <Pill active={subtype==="simple"} onClick={()=>setSubtype("simple")}>Intégral</Pill>
          <Pill active={subtype==="poule"} onClick={()=>setSubtype("poule")}>Poules</Pill>
        </div>}
      {type==="event"&&subtype==="poule"&&<div style={{...card(T.gold),fontSize:12,
        color:T.dim,marginBottom:4,lineHeight:1.5}}>
        🧩 <b style={{color:T.text}}>Poules</b> : tirage en groupes, chacun joue les autres de sa
        poule. <b style={{color:T.gold}}>🚧 En préparation</b> — pour l'instant choisis
        <b style={{color:T.text}}> Intégral</b>, je livre les Poules juste après.</div>}
      {type==="event"&&subtype==="ryder"&&<div style={{...card(T.us),fontSize:12,
        color:T.dim,marginBottom:4}}>
        Ryder Cup : deux équipes, tirage en chapeaux (équilibré par index, totaux serrés)
        à lancer dans le détail du tournoi, et cumul des points sur toutes les manches.</div>}
      {type==="event"&&subtype==="coupe"&&<div style={{...card(T.gold),fontSize:12,
        color:T.dim,marginBottom:4,lineHeight:1.5}}>
        🏆 MiniCup : <b style={{color:T.text}}>élimination directe en 1v1</b>. Tirage full aléatoire,
        le gagnant avance, on se rapproche de la finale (Quarts → Demies → Finale). Choisis le
        format des duels (le même pour tous) :
        <select value={coupeFormula} onChange={e=>setCoupeFormula(e.target.value)}
          style={{...inp,marginTop:6}}>
          <option value="matchplay">Match Play (trou par trou)</option>
          <option value="strokeplay_net">Stroke Play (plus petit score)</option>
          <option value="stableford">Stableford (plus de points)</option>
        </select></div>}

      <div style={{...card(T.line),fontSize:12,color:T.dim,display:"flex",
        alignItems:"center",gap:8}}>
        <span style={{fontSize:18}}>🏷️</span>
        <span>Nom de la partie (auto) : <b style={{color:T.text}}>{finalName()}</b></span></div>

      {(type==="simple"||subtype==="coupe")?(<>
        <Section>Parcours</Section>
        <CourseAutocomplete courses={courses} setCourses={setCourses}
          courseId={courseId} setCourseId={setCourseId}/>
      </>):(<>
        <Section>Manches & parcours</Section>
        <div style={{fontSize:11,color:T.dim,marginBottom:6}}>
          Un tournoi = plusieurs manches, chacune sur son parcours. Mêmes équipes et
          cumul des points sur l'ensemble.</div>
        {rounds.map((r,i)=>(
          <div key={i} style={{display:"flex",alignItems:"flex-end",gap:8,marginBottom:6}}>
            <label style={{flex:1}}>
              <span style={{fontSize:10,color:T.dim}}>MANCHE {i+1}</span>
              <select value={r.courseId} onChange={e=>updRound(i,+e.target.value)}
                style={{...inp,marginTop:2}}>
                {courses.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>
            </label>
            {rounds.length>1&&<button onClick={()=>delRound(i)}
              style={{...delBtn,marginBottom:2}}>✕</button>}
          </div>))}
        <button onClick={addRound} style={{...delBtn,width:"100%",padding:"8px",
          color:T.accent,borderColor:T.accent}}>+ Ajouter une manche</button>
      </>)}
      <Section>Membres</Section>
      <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
        {/* Membres G&A (toujours visibles) + anciens invités déjà sélectionnés */}
        {members.filter(m=>isFounder(m)||selected.includes(m.id)).map(m=>(
          <button key={m.id} onClick={()=>toggle(m.id)} style={{...chip,
            border:`2px solid ${selected.includes(m.id)?T.accent:T.line}`,
            background:selected.includes(m.id)?T.panel2:T.panel}}>
            {dispName(m)} <span style={{color:T.dim}}>({m.index})</span>
            {!isFounder(m)&&<span style={{color:T.gold,fontSize:9}}> invité</span>}</button>))}
      </div>
      {others.filter(m=>!selected.includes(m.id)).length>0 &&
        <select value="" onChange={e=>{const m=others.find(x=>String(x.id)===e.target.value);if(m)toggle(m.id);}}
          style={{...inp,marginTop:8}}>
          <option value="">+ Ajouter un ancien invité…</option>
          {others.filter(m=>!selected.includes(m.id))
            .sort((a,b)=>dispName(a).localeCompare(dispName(b)))
            .map(m=><option key={m.id} value={m.id}>{dispName(m)} ({m.index})</option>)}
        </select>}

      <Section>Invités</Section>
      {guests.map(g=>(<div key={g.id} style={card(T.gold)}>
        <div style={{display:"flex",gap:8}}>
          <input value={g.name} onChange={e=>updGuest(g.id,"name",e.target.value)}
            style={{...inp,fontWeight:800,flex:1}}/>
          <button onClick={()=>delGuest(g.id)} style={delBtn}>✕</button></div>
        <Field label="Index de jeu (sert au calcul des coups rendus)">
          <input type="number" step="0.1" value={g.index}
            onChange={e=>updGuest(g.id,"index",parseFloat(e.target.value)||0)} style={inp}/></Field>
      </div>))}
      <button onClick={addGuest} style={{...addBtn,background:T.panel2,color:T.text,
        border:`1px solid ${T.gold}`}}>+ Ajouter un invité</button>

      {n>0&&teeNames.length>0&&(<>
        <Section>Départs & index de jeu</Section>
        <div style={{fontSize:11,color:T.dim,marginBottom:6}}>
          Départ → CR/Slope. L'<b>index de jeu</b> est le vrai niveau du joueur (souvent
          différent de son index officiel) : c'est lui qui détermine les coups rendus.
          Pré-rempli depuis la fiche, ajustable pour cette partie sans modifier la fiche.</div>
        {allPlayers.map(p=>(
          <div key={p.id} style={{background:T.panel,borderRadius:8,marginBottom:6,
            padding:"8px 10px"}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
              <span style={{width:12,height:12,borderRadius:3,background:teeDot(getTee(p.id)),
                border:`1px solid ${T.line}`,flexShrink:0}}/>
              <span style={{flex:1,fontSize:13,fontWeight:700}}>{dispName(p)}
                {p.guest&&<span style={{color:T.gold,fontSize:10,fontWeight:400}}> · invité</span>}
              </span>
            </div>
            <div style={{display:"flex",gap:8,alignItems:"flex-end"}}>
              <label style={{flex:1}}>
                <span style={{fontSize:10,color:T.dim}}>DÉPART</span>
                <select value={getTee(p.id)} onChange={e=>setTee(p.id,e.target.value)}
                  style={{...inp,marginTop:2}}>
                  {teeNames.map(t=><option key={t} value={t}>{t}</option>)}</select></label>
              <label style={{width:110}}>
                <span style={{fontSize:10,color:T.dim}}>INDEX DE JEU</span>
                <input type="number" step="0.1" value={getIndex(p)}
                  onChange={e=>setOverride(p.id,"index",parseFloat(e.target.value)||0)}
                  style={{...inp,marginTop:2,textAlign:"center"}}/></label>
            </div>
          </div>))}
      </>)}

      <div style={{marginTop:14,padding:"10px 12px",background:T.panel,borderRadius:10,
        fontSize:13}}>👥 {n} joueur{n>1?"s":""} sélectionné{n>1?"s":""}</div>

      {type==="simple"&&(n>=2&&n<=4?(<>
        <Section>1. Formule ({n} joueurs)</Section>
        <select value={formula||""} onChange={e=>setFormula(e.target.value)} style={inp}>
          {simpleFormulas.map(f=><option key={f} value={f}>{FORMULA_LABELS[f]}</option>)}</select>
        {n===3&&formula==="chouette"&&<ChouetteInfo/>}
        {team2v2&&(()=>{
          const c0=allPlayers.filter((p,i)=>getTeam(p.id,i)===0).length;
          const ok=c0===2; // l'autre équipe a forcément les 2 restants
          return (<>
            <Section>2. Les équipes (2 contre 2)</Section>
            <div style={{fontSize:11,color:T.dim,marginBottom:6}}>Désigne qui joue avec qui : touche une équipe pour chaque joueur.</div>
            {allPlayers.map((p,i)=>{const t=getTeam(p.id,i);
              return (<div key={p.id} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                <span style={{flex:1,fontWeight:700,fontSize:13}}>{dispName(p)}</span>
                {[0,1].map(tt=>(<button key={tt} onClick={()=>setTeam(p.id,tt)}
                  style={{...chip,padding:"7px 12px",fontSize:12,
                  border:`2px solid ${t===tt?(tt===0?T.eu:T.us):T.line}`,
                  background:t===tt?(tt===0?T.eu:T.us)+"22":T.panel,
                  color:t===tt?T.text:T.dim,fontWeight:t===tt?800:600}}>
                  {tt===0?"Équipe 1":"Équipe 2"}</button>))}
              </div>);})}
            {!ok&&<div style={{fontSize:11,color:T.gold,marginTop:2}}>⚠️ Il faut 2 joueurs par équipe.</div>}
          </>);
        })()}
        <Section>{team2v2?"3.":"2."} Décompte</Section>
        {brutOnly
          ? <div style={{...card(T.gold),fontSize:12,color:T.dim,lineHeight:1.5}}>
              🌮 La <b style={{color:T.text}}>Mexicaine</b> se joue en <b style={{color:T.text}}>brut</b> :
              système de <b style={{color:T.text}}>points cumulés</b> (pas de net, pas de match play).</div>
          : decompteUI}
      </>):(()=>{
        // PLUS de 4 joueurs : on propose des configurations (ex. 6 → 4+2, 3+3, 2+2+2),
        // une formule par sous-partie, et l'affectation déplaçable des joueurs.
        const sp=split||autoSplit(n);
        const setF=(gi,val)=>setSplit(sp.map((x,k)=>k===gi?{...x,formula:val}:x));
        return (<>
        <Section>1. Configuration ({n} joueurs)</Section>
        <ConfigPicker n={n} current={sp} onPick={sizes=>{setSplit(applyConfig(sp,sizes));setFlightOf({});}}/>
        {sp.map((grp,gi)=>{const cnt=flightCount(gi);const okC=cnt===grp.size;
          return (<div key={gi} style={card(okC?T.accent:T.gold)}>
            <div style={{fontWeight:800,marginBottom:6,display:"flex",justifyContent:"space-between"}}>
              <span>Partie {gi+1} · {grp.size} joueurs</span>
              <span style={{color:okC?T.accent:T.gold,fontSize:12}}>{cnt}/{grp.size}</span></div>
            <select value={grp.formula} onChange={e=>setF(gi,e.target.value)} style={inp}>
              {formulasFor(grp.size).map(f=><option key={f} value={f}>{FORMULA_LABELS[f]}</option>)}</select>
          </div>);})}
        <Section>2. Qui joue dans quelle partie ?</Section>
        <div style={{fontSize:11,color:T.dim,marginBottom:6}}>Tape pour déplacer un joueur d'une partie à l'autre.</div>
        {allPlayers.map(p=>(
          <div key={p.id} style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
            <span style={{flex:1,minWidth:0,fontWeight:700,fontSize:13,whiteSpace:"nowrap",
              overflow:"hidden",textOverflow:"ellipsis"}}>{dispName(p)}</span>
            <div style={{display:"flex",gap:4,flexShrink:0}}>
              {sp.map((grp,gi)=>{const act=flightOfP(p)===gi;
                return <button key={gi} onClick={()=>setFlightOf(o=>({...o,[p.id]:gi}))}
                  style={{...chip,padding:"6px 10px",fontSize:12,
                  border:`2px solid ${act?T.accent:T.line}`,background:act?T.panel2:T.panel,
                  color:act?T.text:T.dim,fontWeight:act?800:600}}>P{gi+1}</button>;})}
            </div>
          </div>))}
        {sp.some((grp,gi)=>flightCount(gi)!==grp.size)&&
          <div style={{fontSize:11,color:T.gold,marginTop:2}}>⚠️ Chaque partie doit avoir son nombre exact de joueurs.</div>}
        <Section>3. Décompte</Section>
        {decompteUI}
        </>);
      })())}

      {type==="event"&&subtype!=="coupe"&&n>=2&&(<>
        <Section>Formules par manche (modifiable)</Section>
        <div style={{fontSize:11,color:T.dim,marginBottom:6}}>
          Chaque manche/jour peut avoir des formules différentes : scramble un jour,
          meilleure-moins bonne un autre, mexicaine le suivant… À toi de choisir.</div>
        {rounds.map((r,ri)=>{
          const c=courses.find(x=>x.id===r.courseId);
          const sp=r.split||autoSplit(n);
          return (
            <div key={ri} style={{...card(T.gold)}}>
              <div style={{fontWeight:800,marginBottom:6,display:"flex",
                alignItems:"center",gap:8}}>
                <span style={{background:T.gold,color:"#1a1200",borderRadius:6,
                  padding:"2px 8px",fontSize:12}}>MANCHE {ri+1}</span>
                <span style={{fontSize:13}}>{c?.name}</span></div>
              {n>4&&<ConfigPicker n={n} current={sp}
                onPick={sizes=>setRoundSplit(ri,applyConfig(sp,sizes))}/>}
              {sp.map((grp,gi)=>(
                <div key={gi} style={{marginBottom:6}}>
                  <span style={{fontSize:10,color:T.dim}}>Match {gi+1} · {grp.size} joueurs</span>
                  <select value={grp.formula} onChange={e=>setRoundSplit(ri,
                    sp.map((x,k)=>k===gi?{...x,formula:e.target.value}:x))}
                    style={{...inp,marginTop:2}}>
                    {formulasFor(grp.size).map(f=>
                      <option key={f} value={f}>{FORMULA_LABELS[f]}</option>)}</select>
                </div>))}
            </div>
          );
        })}
        <div style={{...card(T.eu),fontSize:12,color:T.dim,marginTop:4}}>
          ℹ️ Les joueurs démarrent <b>non affectés</b>. Tu formeras les équipes
          (Équipe 1 / Équipe 2, renommables) dans le détail du tournoi.</div>
        <Section>Décompte</Section>
        {decompteUI}
      </>)}

      <label style={{...card(isTest?T.gold:T.line),display:"flex",alignItems:"center",gap:10,
        marginTop:14,cursor:"pointer"}}>
        <input type="checkbox" checked={isTest} onChange={e=>setIsTest(e.target.checked)}
          style={{width:18,height:18,accentColor:T.gold}}/>
        <span style={{fontSize:13}}><b style={{color:isTest?T.gold:T.text}}>🧪 Partie de test</b>
          <span style={{color:T.dim}}> — ne sera pas comptabilisée au classement</span></span>
      </label>

      <button onClick={create} style={{...addBtn,fontFamily:"'Archivo',sans-serif",fontSize:17,
        letterSpacing:.5,marginTop:16}}>▶ CRÉER & DÉMARRER</button>
    </div>
  );
}
function ChouetteInfo(){return <div style={{...card(T.gold),fontSize:12,color:T.dim,marginTop:8}}>
  🦉 Chouette : 6 pts/trou. 1er 4 · 2e 2 · 3e 0. Égalités : 1ers 3/3/0 · 2es 4/1/1 ·
  triple nul 2/2/2.</div>;}
// Sélecteur de configuration : propose les partitions possibles (ex. 6 → 4+2, 3+3, 2+2+2).
function ConfigPicker({n,current,onPick}){
  const configs=splitConfigs(n);
  if(configs.length<=1) return null; // aucune alternative
  const curKey=current?current.map(g=>g.size).join("-"):"";
  return (<div style={{marginBottom:8}}>
    <div style={{fontSize:10,color:T.dim,marginBottom:4,textTransform:"uppercase",
      letterSpacing:.5,fontWeight:700}}>Configuration des parties</div>
    <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
      {configs.map((sizes,i)=>{const k=sizes.join("-");const active=k===curKey;
        return <button key={i} type="button" onClick={()=>onPick(sizes)}
          style={{...chip,padding:"7px 12px",fontSize:12,
          border:`2px solid ${active?T.accent:T.line}`,background:active?T.panel2:T.panel,
          color:active?T.text:T.dim,fontWeight:active?800:600}}>
          {sizes.join(" + ")}{sizes.length>1?` · ${sizes.length} parties`:""}</button>;})}
    </div></div>);
}
function EventSplit({split,setSplit}){
  const change=(i,f)=>setSplit(split.map((g,j)=>j===i?{...g,formula:f}:g));
  return (<div>{split.map((g,i)=>(<div key={i} style={card(T.accent)}>
    <div style={{fontWeight:800,marginBottom:6}}>Match {i+1} · {g.size} joueurs</div>
    <select value={g.formula} onChange={e=>change(i,e.target.value)} style={inp}>
      {formulasFor(g.size).map(f=><option key={f} value={f}>{FORMULA_LABELS[f]}</option>)}
    </select></div>))}</div>);
}

/* ===== Autocomplétion parcours (API live, repli manuel) ===== */
function CourseAutocomplete({courses,setCourses,courseId,setCourseId}){
  const sel=courses.find(c=>c.id===courseId);
  const [q,setQ]=useState("");
  const [focused,setFocused]=useState(false);
  const [sugg,setSugg]=useState([]);
  const [open,setOpen]=useState(false);
  const [status,setStatus]=useState("");
  // Affichage : hors focus on montre le parcours choisi (ex. Nans par défaut) ; au clic le
  // champ se vide pour taper directement, sans avoir à effacer les lettres une par une.
  const display=focused?q:(sel?.name||q);

  // recherche : d'abord parcours déjà enregistrés, puis API
  useEffect(()=>{
    if(!q || q.length<2){ setSugg([]); return; }
    const local=courses.filter(c=>c.name.toLowerCase().includes(q.toLowerCase()))
      .map(c=>({local:true,course:c}));
    let cancelled=false;
    const id=setTimeout(async()=>{
      let api=[];
      try{
        setStatus("Recherche…");
        const res=await GolfAPI.search(q);
        api=res.map(c=>({local:false,raw:c,
          label:`${c.club_name} — ${c.course_name}`}));
        setStatus("");
      }catch(e){
        if(e.kind==="nokey") setStatus("➕ Saisie manuelle (ajoute ta clé API dans Réglages pour l'auto-complétion mondiale)");
        else setStatus("API indisponible (CORS) — utilise la saisie manuelle.");
      }
      if(!cancelled) setSugg([...local,...api]);
    },350);
    return ()=>{cancelled=true;clearTimeout(id);};
  },[q]);// eslint-disable-line

  const pickLocal=c=>{ setCourseId(c.id); setQ(c.name); setOpen(false); };
  const pickApi=raw=>{
    const c=GolfAPI.toCourse(raw);
    setCourses(prev=>[...prev,c]);
    setCourseId(c.id); setQ(c.name); setOpen(false); setStatus("✅ Parcours importé");
  };
  const createManual=()=>{
    const c={id:Date.now(),name:q||"Nouveau parcours",country:"France",par:72,
      si:Array.from({length:18},(_,i)=>i+1),tees:[{name:"Jaune",cr:72,slope:130,par:72}]};
    setCourses(prev=>[...prev,c]); setCourseId(c.id); setOpen(false);
    setStatus("Créé — complète départs/SSS dans l'onglet Parcours");
  };

  return (
    <div style={{position:"relative"}}>
      <Field label="Parcours (tape pour rechercher)">
        <input value={display}
          onFocus={()=>{setFocused(true);setQ("");setOpen(true);}}
          onBlur={()=>setTimeout(()=>{setFocused(false);setOpen(false);},150)}
          onChange={e=>{setQ(e.target.value);setOpen(true);}}
          placeholder="Tape le nom du parcours…" style={inp}/></Field>
      {status && <div style={{fontSize:11,color:T.gold,marginTop:4}}>{status}</div>}
      {open && sugg.length>0 && (
        <div style={{background:T.panel2,border:`1px solid ${T.line}`,borderRadius:10,
          marginTop:4,overflow:"hidden"}}>
          {sugg.map((s,i)=>(
            <div key={i} onClick={()=>s.local?pickLocal(s.course):pickApi(s.raw)}
              style={{padding:"9px 11px",cursor:"pointer",fontSize:13,
              borderBottom:`1px solid ${T.line}33`}}>
              {s.local? <><b>{s.course.name}</b> <span style={{color:T.accent,
                fontSize:10}}>· enregistré</span></>
                : <><b>{s.label}</b> <span style={{color:T.dim,fontSize:10}}>· importer</span></>}
            </div>))}
        </div>
      )}
      {open && q.length>=2 && (
        <div onClick={createManual} style={{padding:"8px 11px",marginTop:4,
          background:T.panel,borderRadius:8,fontSize:12,color:T.accent,cursor:"pointer"}}>
          ➕ Créer « {q} » manuellement</div>
      )}
    </div>
  );
}

/* ===== CHAMPIONNAT : points 2/1/0 par joueur, cumulé + moyenne + confrontations ===== */
// Classement de saison à partir des parties terminées → {S:id->{pts,played,win,draw,loss}, H}.
// Réutilisé pour le championnat ET le résumé de fin de partie.
// Une manche (sous-partie) n'est COMPLÈTE que si les 18 trous sont remplis pour TOUS
// ses joueurs. Une manche à moins de 2 joueurs (bye de coupe) n'est pas une vraie manche.
function subComplete(sg){
  const ps=sg?.players||[];
  if(ps.length<2) return false; // bye / manche vide : pas une vraie confrontation
  for(const pid of ps){
    const sc=sg.scores?.[pid];
    if(!sc) return false;
    for(let h=0;h<18;h++){ if(sc[h]==null) return false; }
  }
  return true;
}
// Une partie/compétition n'est COMPLÈTE (et donc comptabilisée au classement) que s'il
// existe au moins une vraie manche et que TOUTES les vraies manches ont leurs 18 trous
// remplis pour tous les joueurs. → tant qu'une compétition n'est pas réellement jouée,
// elle ne rapporte aucun point (ex. une Ryder Cup créée mais pas encore disputée).
function gameComplete(g){
  const subs=g.rounds?g.rounds.flatMap(r=>r.subgames||[]):(g.subgames||[]);
  const real=subs.filter(s=>(s.players||[]).length>=2);
  if(!real.length) return false;
  return real.every(subComplete);
}
// Liste des manches non terminées (pour expliquer pourquoi on ne peut pas valider).
function incompleteSubs(g){
  const subs=g.rounds
    ? g.rounds.flatMap((r,ri)=>r.subgames.map((sg,si)=>({sg,label:`Manche ${ri+1}-${si+1}`})))
    : (g.subgames||[]).map((sg,si)=>({sg,label:g.subgames.length>1?`Partie ${si+1}`:"La partie"}));
  return subs.filter(({sg})=>(sg.players||[]).length>=2 && !subComplete(sg)).map(x=>x.label);
}

function computeStandings(done, courses){
  const S={}, H={}, D={}; // D : id -> [{id,name,pts}] détail des points par partie
  const detail=(id,gid,name,pts)=>{(D[id]=D[id]||[]).push({id:gid,name,pts});};
  // sécurité : on ne compte chaque partie qu'UNE fois (au cas où un doublon traînerait)
  {const seen=new Set();done=(done||[]).filter(g=>{const k=String(g.id);
    if(seen.has(k))return false;seen.add(k);return true;});}
  const ensure=id=>{if(!S[id])S[id]={pts:0,played:0,win:0,draw:0,loss:0};return S[id];};
  // RÈGLE CLASSEMENT : tout le monde peut jouer, mais une confrontation ne compte au
  // classement que si AU MOINS 2 membres G&A y participent (sinon : ignorée).
  const isMember=p=>p?.member===true || /^seed-/.test(String(p?.id));
  const counts=ps=>ps.filter(isMember).length>=2;
  done.forEach(g=>{
    if(g.test) return;           // partie de TEST → jamais comptabilisée au classement
    if(!gameComplete(g)) return; // partie non disputée / 18 trous non remplis → 0 point
    const net=g.mode==="net";
    const subs=g.rounds
      ? g.rounds.flatMap(r=>r.subgames.map(sg=>({sg,course:courses.find(c=>c.id===r.courseId)})))
      : (g.subgames||[]).map(sg=>({sg,course:courses.find(c=>c.id===g.courseId)}));
    const teamTournament = g.rounds && g.teamNames && g.roster?.some(p=>p.team===0||p.team===1);
    if(teamTournament){
      // SOLIDARITÉ : chaque match d'équipe compte pour TOUS les coéquipiers (on gagne et on
      // perd ensemble, pas de carte individuelle). +5 trophée à l'équipe championne.
      const teamWins=[0,0]; const gp={};
      subs.forEach(({sg,course})=>{
        const psAll=sg.players.map(id=>g.roster.find(p=>p.id===id)).filter(Boolean);
        if(!counts(psAll)) return; // pas assez de membres → ne compte pas au classement
        // on calcule sur l'équipe COMPLÈTE (invités compris pour le résultat) ; seuls les
        // MEMBRES marquent les points (boucle ci-dessous filtre déjà les invités).
        const {pts}=playerScores(sg,psAll,course,net);
        const ts=[0,0];
        psAll.forEach(p=>{ if(p.team===0||p.team===1) ts[p.team]+=(pts[p.id]||0); });
        const winT=ts[0]>ts[1]?0:ts[1]>ts[0]?1:null;
        if(winT!=null) teamWins[winT]++;
        g.roster.forEach(p=>{ if(p.team!==0&&p.team!==1) return; if(!isMember(p)) return; // exclure les invités
          const s=ensure(p.id); s.played++;
          let add; if(winT==null){add=1;s.draw++;} else if(p.team===winT){add=3;s.win++;} else {add=0;s.loss++;}
          s.pts+=add; gp[p.id]=(gp[p.id]||0)+add; });
      });
      const champ=teamWins[0]>teamWins[1]?0:teamWins[1]>teamWins[0]?1:null;
      if(champ!=null) g.roster.forEach(p=>{ if(p.team===champ&&isMember(p)&&S[p.id]){ S[p.id].pts+=5; gp[p.id]=(gp[p.id]||0)+5; } });
      // PRIME DE PARTICIPATION : qui est venu et a tout perdu repart quand même avec 1 point
      // (il mérite plus que ceux qui ne sont pas venus = 0).
      Object.keys(gp).forEach(id=>{ if(gp[id]===0 && S[id]){ S[id].pts+=1; gp[id]=1; } });
      Object.entries(gp).forEach(([id,pt])=>detail(id,g.id,g.name,pt));
      return;
    }
    // INDIVIDUEL (amicale ou tournoi individuel) : points par duels + confrontations + bonus
    const gamePts={};
    subs.forEach(({sg,course})=>{
      const psAll=sg.players.map(id=>g.roster.find(p=>p.id===id)).filter(Boolean);
      if(!counts(psAll)) return; // pas assez de membres → ne compte pas au classement
      const isTeam=TEAM_2V2.includes(sg.formula);
      // Équipe (2v2) : on calcule sur l'équipe COMPLÈTE (invité compris pour déterminer qui
      // gagne), puis on n'attribue les points QU'AUX MEMBRES. Non-équipe : seuls les duels
      // MEMBRE contre MEMBRE comptent (les invités sont retirés du calcul).
      const scoring = isTeam ? psAll : psAll.filter(isMember);
      const {pts,h2h,res}=playerScores(sg,scoring,course,net);
      Object.entries(pts).forEach(([id,pt])=>{
        const pl=psAll.find(p=>String(p.id)===String(id));
        if(!isMember(pl)) return; // les INVITÉS ne marquent jamais
        const s=ensure(id);s.pts+=pt;s.played++;gamePts[id]=(gamePts[id]||0)+pt;
        const r=res?.[id];
        if(r==='W')s.win++;else if(r==='D')s.draw++;else s.loss++;});
      h2h.forEach(({a,b,res})=>{
        const key=a<b?`${a}|${b}`:`${b}|${a}`;
        if(!H[key])H[key]={a:0,b:0,nul:0};
        const flip=!(a<b);
        if(res==="nul")H[key].nul++;
        else if((res==="a")!==flip)H[key].a++;else H[key].b++;
      });
    });
    if(g.rounds){ // tournoi individuel : +5 au meilleur total de la partie
      const ids=Object.keys(gamePts);
      if(ids.length){ const mx=Math.max(...ids.map(id=>gamePts[id]));
        ids.filter(id=>gamePts[id]===mx).forEach(id=>{ if(S[id]){ S[id].pts+=5; gamePts[id]+=5; } }); }
    }
    Object.entries(gamePts).forEach(([id,pt])=>detail(id,g.id,g.name,pt));
  });
  // « parties jouées » = nombre de PARTIES distinctes (pas de manches) → moyenne juste
  Object.keys(S).forEach(id=>{ S[id].played=(D[id]||[]).length; });
  return {S,H,D};
}

// Impact d'une partie sur le classement de saison : points gagnés + nouveau total/rang.
function seasonImpact(g, games, courses){
  const done=games.filter(x=>x.done);
  const afterS=computeStandings(done,courses).S;
  const beforeS=computeStandings(done.filter(x=>String(x.id)!==String(g.id)),courses).S;
  // rang au classement CUMULÉ (par points), avant et après la partie
  const rankMap=S=>{const m={};Object.entries(S).map(([id,s])=>({id,pts:s.pts}))
    .sort((x,y)=>y.pts-x.pts).forEach((e,i)=>m[e.id]=i+1);return m;};
  const aR=rankMap(afterS), bR=rankMap(beforeS);
  // EXCLURE LES INVITÉS de l'évolution au classement
  const isMember=p=>p?.member===true||/^seed-/.test(String(p?.id));
  const ids=[...new Set((g.roster||[]).filter(isMember).map(p=>p.id))];
  const lines=ids.map(id=>{const a=afterS[id]||{pts:0}, b=beforeS[id]||{pts:0};
    const ar=aR[id]||null, br=bR[id]||null;
    return {id, gained:Math.round(((a.pts||0)-(b.pts||0))*10)/10, total:a.pts||0,
      rank:ar, delta:(ar&&br)?(br-ar):null, isNew:!!(ar&&!br)}; // delta>0 = a gagné des places
  }).sort((x,y)=>(x.rank||99)-(y.rank||99)); // ordre du classement général
  // la partie compte-t-elle au classement ? (≥2 membres dans au moins une confrontation)
  const subs=g.rounds?g.rounds.flatMap(r=>r.subgames||[]):(g.subgames||[]);
  const counted=!g.test && gameComplete(g) && subs.some(sg=>(sg.players||[]).map(id=>(g.roster||[]).find(p=>p.id===id))
    .filter(Boolean).filter(isMember).length>=2);
  return {lines,counted};
}

// ===== RYDER : équipe gagnante, compteur de Ryder gagnées par joueur =====
// Équipe gagnante d'une Ryder (0/1) = celle qui remporte le + de matchs. null si indéterminé.
function ryderWinningTeam(g,courses){
  if(g?.subtype!=="ryder"||!g.rounds) return null;
  const net=g.mode==="net";const teamWins=[0,0];
  g.rounds.forEach(r=>{const course=(courses||[]).find(c=>c.id===r.courseId);
    (r.subgames||[]).forEach(sg=>{ if(!subComplete(sg)) return;
      const ps=sg.players.map(id=>(g.roster||[]).find(p=>p.id===id)).filter(Boolean);
      const {pts}=playerScores(sg,ps,course,net);const ts=[0,0];
      ps.forEach(p=>{if(p.team===0||p.team===1)ts[p.team]+=(pts[p.id]||0);});
      const w=ts[0]>ts[1]?0:ts[1]>ts[0]?1:null; if(w!=null)teamWins[w]++; });});
  return teamWins[0]>teamWins[1]?0:teamWins[1]>teamWins[0]?1:null;
}
// Nombre de Ryder gagnées par joueur (DÉRIVÉ de l'historique → se met à jour si on supprime).
function ryderWinsMap(games,courses){
  const map={};
  (games||[]).filter(g=>g.subtype==="ryder"&&g.done&&!g.test).forEach(g=>{
    const w=ryderWinningTeam(g,courses); if(w==null) return;
    (g.roster||[]).forEach(p=>{ if(p.team===w) map[String(p.id)]=(map[String(p.id)]||0)+1; });});
  return map;
}
// Gagnants de la Ryder la plus récente (Set d'ids) — pour la mise en avant sur l'accueil.
function lastRyderWinners(games,courses){
  const ryders=(games||[]).filter(g=>g.subtype==="ryder"&&g.done&&!g.test)
    .sort((a,b)=>(b.created||0)-(a.created||0));
  for(const g of ryders){const w=ryderWinningTeam(g,courses);
    if(w!=null) return new Set((g.roster||[]).filter(p=>p.team===w).map(p=>String(p.id)));}
  return new Set();
}

function Championship(){
  const {games,members,courses}=useContext(Ctx);
  const done=games.filter(g=>g.done);
  const stats=useMemo(()=>computeStandings(done,courses),[done,courses]);
  const [openP,setOpenP]=useState(null);

  const rows=members.map(m=>({m,...(stats.S[m.id]||{pts:0,played:0,win:0,draw:0,loss:0})}))
    .map(r=>({...r,avg:r.played?r.pts/r.played:0}));
  const byTotal=[...rows].filter(r=>r.played>0).sort((a,b)=>b.pts-a.pts||b.avg-a.avg);
  const byAvg=[...rows].filter(r=>r.played>0).sort((a,b)=>b.avg-a.avg||b.pts-a.pts);

  if(!done.length) return <Empty text="Aucune partie terminée. Valide des parties pour alimenter le championnat."/>;

  return (
    <div>
      <Section>Championnat</Section>
      <div style={{...card(T.gold),fontSize:12,color:T.dim,lineHeight:1.5}}>
        🏅 <b style={{color:T.text}}>Points par DUEL</b> (qui bat qui) :
        {" "}<b style={{color:T.text}}>1v1</b> → V 3 · N 1 · D 0.
        {" "}<b style={{color:T.text}}>À 3</b> → 2 duels (V 2 · N 1 · D 0) : battre les 2 = 4.
        {" "}<b style={{color:T.text}}>Double 2v2</b> → V 3 · N 1 · D 0 par équipier.
        {" "}<b style={{color:T.text}}>Tournoi</b> : chaque manche compte +
        {" "}<b style={{color:T.gold}}>🏆 +5 au vainqueur</b>. Deux classements :
        {" "}<b style={{color:T.text}}>cumulé</b> et <b style={{color:T.text}}>moyenne/partie</b>.
        {" "}⚖️ Seules les confrontations avec <b style={{color:T.text}}>≥ 2 membres G&A</b> comptent
        {" "}(les autres se jouent mais hors classement).</div>

      <div style={{display:"flex",gap:10,marginTop:4}}>
        <RankCol title="🔢 CUMULÉ" rows={byTotal} metric={r=>r.pts} unit="pts"/>
        <RankCol title="📊 MOYENNE" rows={byAvg} metric={r=>r.avg.toFixed(2)} unit="pts/p."/>
      </div>

      <Section>🔎 Détail des points</Section>
      <div style={{fontSize:11,color:T.dim,marginBottom:6}}>
        Tape un joueur pour voir d'où viennent ses points, partie par partie.</div>
      {byTotal.map(r=>{const det=stats.D[r.m.id]||[];const op=openP===r.m.id;return (
        <div key={r.m.id} style={{...card(T.line),marginBottom:6}}>
          <div onClick={()=>setOpenP(op?null:r.m.id)} style={{display:"flex",
            justifyContent:"space-between",alignItems:"center",cursor:"pointer"}}>
            <span style={{fontWeight:700}}>{dispName(r.m)}</span>
            <span style={{fontSize:12,color:T.dim}}>
              <b style={{color:T.accent}}>{r.pts} pts</b> · {r.played} partie{r.played>1?"s":""} {op?"▾":"▸"}</span>
          </div>
          {op&&<div style={{marginTop:6,borderTop:`1px solid ${T.line}`,paddingTop:6}}>
            {det.map((d,i)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",
                fontSize:12,marginBottom:3,gap:8}}>
                <span style={{flex:1,color:T.dim,overflow:"hidden",textOverflow:"ellipsis",
                  whiteSpace:"nowrap"}}>{d.name||"Partie"}</span>
                <span style={{fontWeight:800,color:d.pts>0?T.accent:T.dim}}>+{d.pts}</span>
              </div>))}
            {!det.length&&<div style={{fontSize:11,color:T.dim}}>Aucune partie comptée.</div>}
          </div>}
        </div>);})}

      <Section>Confrontations (face-à-face)</Section>
      <H2HTable H={stats.H} members={members}/>
    </div>
  );
}
function RankCol({title,rows,metric,unit}){
  return (
    <div style={{flex:1,background:T.panel,borderRadius:12,padding:10,
      border:`1px solid ${T.line}`}}>
      <div style={{fontFamily:"Anton",fontSize:13,marginBottom:8,letterSpacing:.5}}>{title}</div>
      {rows.map((r,i)=>(
        <div key={r.m.id} style={{display:"flex",alignItems:"center",gap:6,
          padding:"5px 0",borderBottom:i<rows.length-1?`1px solid ${T.line}33`:"none"}}>
          <span style={{fontFamily:"Anton",fontSize:15,width:18,
            color:i===0?T.gold:T.dim}}>{i+1}</span>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontWeight:800,fontSize:13,whiteSpace:"nowrap",overflow:"hidden",
              textOverflow:"ellipsis"}}>{dispName(r.m)}</div>
            <div style={{fontSize:9,color:T.dim}}>{r.played}p · {r.win}V {r.draw}N {r.loss}D</div>
          </div>
          <span style={{fontFamily:"Anton",fontSize:16,
            color:i===0?T.gold:T.accent}}>{metric(r)}</span>
        </div>
      ))}
    </div>
  );
}
function H2HTable({H,members}){
  const entries=Object.entries(H);
  if(!entries.length) return <Empty text="Pas encore de confrontations individuelles."/>;
  const name=id=>{const m=members.find(x=>String(x.id)===String(id));return m?dispName(m):"?";};
  return (
    <div>
      {entries.map(([key,r])=>{
        const [a,b]=key.split("|");
        const lead=r.a>r.b?T.accent:r.b>r.a?T.us:T.dim;
        return (
          <div key={key} style={{...card(lead),display:"flex",alignItems:"center",
            gap:8,padding:"10px 12px"}}>
            <span style={{flex:1,fontWeight:800,textAlign:"right"}}>{name(a)}</span>
            <span style={{fontFamily:"Anton",fontSize:18,minWidth:64,textAlign:"center"}}>
              {r.a} - {r.b}</span>
            <span style={{flex:1,fontWeight:800}}>{name(b)}</span>
            {r.nul>0&&<span style={{fontSize:10,color:T.dim}}>({r.nul} nul)</span>}
          </div>
        );
      })}
    </div>
  );
}

function PlayersTab(){
  const {members,setMembers,admin}=useContext(Ctx);
  const upd=(id,k,v)=>setMembers(members.map(m=>m.id===id?{...m,[k]:v}:m));
  const del=id=>setMembers(members.filter(m=>m.id!==id));
  const add=()=>setMembers([...members,{id:Date.now(),name:"",nick:"",index:20}]);
  // Lecture seule pour les non-admins : personne ne modifie la fiche d'un autre.
  if(!admin){
    return (
      <div>
        <Section>Joueurs membres ({members.length})</Section>
        <div style={{...card(T.gold),fontSize:12,color:T.dim,lineHeight:1.5}}>
          🔒 Les fiches des joueurs sont gérées par l'organisateur. Pour modifier
          <b style={{color:T.text}}> TA</b> fiche (surnom, niveau…), va dans <b style={{color:T.text}}>👤 Mon compte</b>.</div>
        {members.map(m=>(
          <div key={m.id} style={{...card(T.line),display:"flex",alignItems:"center",gap:10}}>
            <span style={{width:34,height:34,borderRadius:"50%",background:T.accent,color:T.ink,
              display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,
              flexShrink:0}}>{(dispName(m)[0]||"?").toUpperCase()}</span>
            <span style={{flex:1,fontWeight:700}}>{dispName(m)}</span>
            <span style={{color:T.dim,fontSize:13}}>index {m.index}</span>
          </div>))}
      </div>
    );
  }
  return (
    <div>
      <Section>Joueurs membres ({members.length})</Section>
      <div style={{...card(T.gold),fontSize:12,color:T.dim}}>
        👤 Pour chaque joueur : son <b style={{color:T.text}}>prénom</b> et surtout son
        <b style={{color:T.text}}> surnom</b>, qui sera affiché partout dans l'app.
        L'<b style={{color:T.text}}>index de jeu</b> (vrai niveau) sert de valeur par
        défaut, ajustable à chaque partie.</div>
      {members.map(m=>(
        <div key={m.id} style={card(T.accent)}>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            <span style={{fontFamily:"Anton",fontSize:18,color:T.gold,minWidth:0,
              flex:"0 0 auto",maxWidth:120,overflow:"hidden",textOverflow:"ellipsis",
              whiteSpace:"nowrap"}}>{dispName(m)}</span>
            <button onClick={()=>del(m.id)} style={{...delBtn,marginLeft:"auto"}}>✕</button>
          </div>
          <div style={{display:"flex",gap:8}}>
            <Field label="Prénom"><input value={m.name}
              onChange={e=>upd(m.id,"name",e.target.value)} placeholder="ex: Jean-Pierre"
              style={inp}/></Field>
            <Field label="Surnom (affiché)"><input value={m.nick||""}
              onChange={e=>upd(m.id,"nick",e.target.value)} placeholder="ex: JP"
              style={{...inp,borderColor:T.gold}}/></Field>
          </div>
          <Field label="Index de jeu (vrai niveau, sert au calcul)">
            <input type="number" step="0.1" value={m.index}
              onChange={e=>upd(m.id,"index",parseFloat(e.target.value)||0)} style={inp}/></Field>
          <div style={{display:"flex",gap:8}}>
            <Field label="Email"><input type="email" value={m.email||""}
              onChange={e=>upd(m.id,"email",e.target.value)} placeholder="pour les résultats"
              style={inp}/></Field>
            <Field label="Mobile"><input type="tel" value={m.mobile||""}
              onChange={e=>upd(m.id,"mobile",e.target.value)} placeholder="06 12 34 56 78"
              style={inp}/></Field>
          </div>
        </div>
      ))}
      <button onClick={add} style={addBtn}>+ Ajouter un joueur membre</button>
    </div>
  );
}

function SettingsTab(){
  const {user,setUser}=useContext(Ctx);
  const [apiKey,setApiKey]=useState(DB.lget("apiKey",DEFAULT_API_KEY));
  const [saved,setSaved]=useState(false);
  const [diag,setDiag]=useState("");
  const [wa,setWa]=useState(DB.lget("waGroup",DEFAULT_WA));
  const [waSaved,setWaSaved]=useState(false);
  // mon profil (compte connecté)
  const [prof,setProf]=useState({name:user?.name||"",nick:user?.nick||"",
    email:user?.email||"",mobile:user?.mobile||""});
  const [profSaved,setProfSaved]=useState(false);
  const saveProf=()=>{setUser({...user,name:prof.name.trim()||user?.name,
    nick:prof.nick.trim(),email:prof.email.trim(),mobile:prof.mobile.trim()});
    setProfSaved(true);setTimeout(()=>setProfSaved(false),1500);};
  // service email (stocké, actif seulement avec Supabase) — plus de SMS (payant)
  const [mail,setMail]=useState(DB.lget("mailSvc",{provider:"resend",key:"",from:""}));
  const [msgSaved,setMsgSaved]=useState(false);
  const save=()=>{DB.lset("apiKey",apiKey.trim());setSaved(true);setTimeout(()=>setSaved(false),1500);};
  const saveWa=()=>{DB.lset("waGroup",wa.trim());setWaSaved(true);setTimeout(()=>setWaSaved(false),1500);};
  const saveMsg=()=>{DB.lset("mailSvc",mail);
    setMsgSaved(true);setTimeout(()=>setMsgSaved(false),1500);};
  return (
    <div>
      <Section>Réglages</Section>

      <div style={card(T.eu)}>
        <div style={{fontWeight:800,marginBottom:8}}>👤 Mon profil</div>
        <div style={{display:"flex",gap:8}}>
          <Field label="Prénom"><input value={prof.name}
            onChange={e=>setProf({...prof,name:e.target.value})} style={inp}/></Field>
          <Field label="Surnom (affiché)"><input value={prof.nick}
            onChange={e=>setProf({...prof,nick:e.target.value})}
            placeholder="ex: Passe-partout" style={{...inp,borderColor:T.gold}}/></Field>
        </div>
        <Field label="Email"><input type="email" value={prof.email}
          onChange={e=>setProf({...prof,email:e.target.value})} style={inp}/></Field>
        <Field label="Mobile"><input type="tel" value={prof.mobile}
          onChange={e=>setProf({...prof,mobile:e.target.value})}
          placeholder="06 12 34 56 78" style={inp}/></Field>
        <button onClick={saveProf} style={{...addBtn,background:T.eu,color:"#fff"}}>
          {profSaved?"✅ Profil enregistré":"Enregistrer mon profil"}</button>
      </div>

      <div style={card(T.accent)}>
        <div style={{fontWeight:800,marginBottom:6}}>🔑 Clé GolfCourseAPI</div>
        <div style={{fontSize:12,color:T.dim,marginBottom:8,lineHeight:1.5}}>
          Colle ta clé une seule fois ici. Elle permet de rechercher n'importe quel parcours
          du monde et d'importer automatiquement ses départs, SSS/Slope, et le par + handicap
          de chaque trou (pour calculer les coups rendus). Compte gratuit sur golfcourseapi.com.</div>
        <input value={apiKey} onChange={e=>setApiKey(e.target.value)}
          placeholder="Colle ta clé ici" style={inp}/>
        <button onClick={save} style={addBtn}>{saved?"✅ Enregistrée":"Enregistrer la clé"}</button>
        <button onClick={async()=>{DB.lset("apiKey",apiKey.trim());setDiag("Test en cours…");
          setDiag(await GolfAPI.test());}}
          style={{...delBtn,width:"100%",marginTop:8,padding:"12px"}}>🔌 Tester la connexion</button>
        {diag&&<div style={{fontSize:12,marginTop:10,padding:"10px 12px",background:T.bg,
          borderRadius:10,border:`1px solid ${T.line}`,lineHeight:1.5,color:T.text}}>{diag}</div>}
      </div>

      <div style={card(T.violet)}>
        <div style={{fontWeight:800,marginBottom:4}}>📨 Notifications</div>
        <div style={{fontSize:11,color:T.dim,marginBottom:10,lineHeight:1.5}}>
          Les résultats se partagent <b style={{color:T.text}}>gratuitement sur WhatsApp</b>
          {" "}(bouton « Partager » sur une partie terminée → ton groupe). Pas de SMS : l'envoi
          de SMS est payant. L'email automatique ci-dessous sera activé avec Supabase.</div>

        <div style={{fontSize:11,color:T.dim,textTransform:"uppercase",letterSpacing:.5,
          fontWeight:700,marginBottom:6}}>✉️ Service email (optionnel, plus tard)</div>
        <div style={{fontSize:11,color:T.gold,marginBottom:8,
          background:`${T.gold}1a`,border:`1px solid ${T.gold}44`,borderRadius:10,
          padding:"8px 10px",lineHeight:1.5}}>
          ⏳ Activé une fois Supabase branché (l'envoi passe par un serveur sécurisé).</div>
        <select value={mail.provider} onChange={e=>setMail({...mail,provider:e.target.value})}
          style={{...inp,marginTop:0}}>
          <option value="resend">Resend (gratuit jusqu'à un volume)</option>
          <option value="sendgrid">SendGrid</option>
          <option value="brevo">Brevo (ex-Sendinblue)</option>
        </select>
        <input value={mail.key} onChange={e=>setMail({...mail,key:e.target.value})}
          placeholder="Clé API email" style={{...inp,marginTop:8}}/>
        <input value={mail.fromName||""} onChange={e=>setMail({...mail,fromName:e.target.value})}
          placeholder="Nom affiché (ex: Du Golf & des Amis)" style={{...inp,marginTop:8}}/>
        <input value={mail.from} onChange={e=>setMail({...mail,from:e.target.value})}
          placeholder="Email expéditeur" style={{...inp,marginTop:8}}/>
        <div style={{fontSize:10,color:T.dim,marginTop:6,lineHeight:1.4}}>
          💡 Le « nom affiché » est ce que voient tes amis (ex. « Du Golf & des Amis »).
          Avec un service email, l'adresse réelle peut rester masquée derrière ce nom — ce que
          Gmail seul ne permet pas.</div>

        <button onClick={saveMsg} style={{...addBtn,background:T.violet,color:"#fff"}}>
          {msgSaved?"✅ Enregistré":"Enregistrer"}</button>
      </div>

      <div style={card("#25D366")}>
        <div style={{fontWeight:800,marginBottom:6}}>💬 Groupe WhatsApp des adhérents</div>
        <div style={{fontSize:12,color:T.dim,marginBottom:8,lineHeight:1.5}}>
          Colle ici le lien d'invitation de votre groupe WhatsApp (dans WhatsApp : Infos du
          groupe → Inviter via un lien → Copier). Un bouton « Discuter » apparaîtra sur
          l'accueil pour rejoindre/ouvrir le groupe avant les parties.</div>
        <input value={wa} onChange={e=>setWa(e.target.value)}
          placeholder="https://chat.whatsapp.com/..." style={inp}/>
        <button onClick={saveWa} style={{...addBtn,background:"#25D366",color:"#062b14"}}>
          {waSaved?"✅ Enregistré":"Enregistrer le lien"}</button>
      </div>

      <div style={{...card(T.gold),fontSize:12,color:T.dim}}>
        ℹ️ Note : l'appel direct depuis le navigateur peut être bloqué (CORS). Si la recherche
        mondiale ne répond pas, l'app bascule sur tes parcours enregistrés + la saisie manuelle.
        Le branchement Supabase (à venir) servira de relais pour fiabiliser cette recherche.</div>
    </div>
  );
}

function CoursesTab(){
  const {courses,setCourses,admin}=useContext(Ctx);
  const [q,setQ]=useState("");
  const upd=(id,k,v)=>setCourses(courses.map(c=>c.id===id?{...c,[k]:v}:c));
  const del=id=>setCourses(courses.filter(c=>c.id!==id));
  const add=()=>setCourses([{id:Date.now(),name:"Nouveau parcours",
    country:"France",par:72,si:Array.from({length:18},(_,i)=>i+1),
    tees:[{name:"Jaune",cr:72,slope:130,par:72}]},...courses]);
  const filtered=q?courses.filter(c=>c.name.toLowerCase().includes(q.toLowerCase())):courses;
  return (
    <div>
      <Section>Mes parcours ({courses.length})</Section>
      <div style={{...card(T.gold),fontSize:12,color:T.dim}}>
        🗺️ <b style={{color:T.text}}>Base de parcours persistante.</b> Saisis un parcours
        une seule fois (départs + SSS/Slope/Par) : il est mémorisé pour toujours et
        réutilisable dans toutes tes parties. Idéal pour préparer un trip à l'avance
        (Catalogne déjà chargée, Irlande, etc.) — tout sera prêt pour calculer les
        coups rendus le jour J.</div>
      <input value={q} onChange={e=>setQ(e.target.value)}
        placeholder="🔍 Filtrer mes parcours…" style={inp}/>
      <button onClick={add} style={addBtn}>+ Ajouter un parcours (avance de phase)</button>
      {!admin&&<div style={{fontSize:11,color:T.dim,marginTop:6,textAlign:"center"}}>
        🔒 Tu peux créer et corriger des parcours. Seul l'organisateur peut en supprimer.</div>}
      <div style={{marginTop:10}}>
        {filtered.map(c=><CourseCard key={c.id} c={c} upd={upd} del={del} admin={admin}/>)}
        {filtered.length===0&&<Empty text="Aucun parcours ne correspond."/>}
      </div>
    </div>
  );
}
function CourseCard({c,upd,del,admin}){
  const setTees=tees=>upd(c.id,"tees",tees);
  const addTee=()=>{const preset=TEE_PRESETS[c.country]||TEE_PRESETS.France;
    const used=(c.tees||[]).map(t=>t.name);
    const next=preset.find(x=>!used.includes(x))||("Départ "+((c.tees?.length||0)+1));
    setTees([...(c.tees||[]),{name:next,cr:72,slope:130,par:c.par||72}]);};
  const updTee=(i,k,v)=>setTees(c.tees.map((t,j)=>j===i?{...t,[k]:v}:t));
  const delTee=i=>setTees(c.tees.filter((_,j)=>j!==i));
  const preset=TEE_PRESETS[c.country]||TEE_PRESETS.France;
  return (
    <div style={card(T.accent)}>
      <div style={{display:"flex",gap:8}}>
        <input value={c.name} onChange={e=>upd(c.id,"name",e.target.value)}
          style={{...inp,fontWeight:800,flex:1}}/>
        {admin&&<button onClick={()=>del(c.id)} style={delBtn} title="Supprimer (admin)">✕</button>}</div>
      <div style={{display:"flex",gap:8,marginTop:8}}>
        <Field label="Pays (norme couleurs)">
          <select value={c.country||"France"} onChange={e=>upd(c.id,"country",e.target.value)}
            style={inp}>{Object.keys(TEE_PRESETS).map(k=><option key={k}>{k}</option>)}</select>
        </Field>
        <Field label="Par parcours"><input type="number" value={c.par??72}
          onChange={e=>upd(c.id,"par",+e.target.value)} style={inp}/></Field>
      </div>
      <div style={{fontSize:11,color:T.dim,margin:"10px 0 4px",fontWeight:700}}>
        DÉPARTS — saisis surtout le <span style={{color:T.gold}}>SLOPE</span> de chaque couleur
        (le SSS/CR est optionnel)</div>
      {(()=>{const miniLab={fontSize:9,color:T.dim,fontWeight:700,letterSpacing:.3,
        marginBottom:2,textAlign:"center"};
       const cell={...inp,marginTop:0,padding:"7px 4px",textAlign:"center",width:"100%"};
       return (c.tees||[]).map((t,i)=>(
        <div key={i} style={{border:`1px solid ${T.line}`,borderRadius:10,
          padding:"8px",marginBottom:8}}>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:7}}>
            <span style={{width:14,height:14,borderRadius:3,background:teeDot(t.name),
              border:`1px solid ${T.line}`,flexShrink:0}}/>
            <select value={t.name} onChange={e=>updTee(i,"name",e.target.value)}
              style={{...inp,marginTop:0,flex:1,padding:"7px"}}>
              {[...new Set([...preset,t.name])].map(p=><option key={p}>{p}</option>)}</select>
            <button onClick={()=>delTee(i)} style={{...delBtn,padding:"6px 10px"}}>✕</button>
          </div>
          <div style={{display:"flex",gap:6,alignItems:"flex-end"}}>
            <div style={{flex:1.4}}>
              <div style={{...miniLab,color:T.gold}}>SLOPE</div>
              <input type="number" inputMode="numeric" value={t.slope??""} placeholder="ex: 134"
                onChange={e=>updTee(i,"slope",e.target.value===""?undefined:+e.target.value)}
                style={{...cell,borderColor:T.gold,fontWeight:800}}/></div>
            <div style={{flex:1.2}}>
              <div style={miniLab}>SSS/CR (opt.)</div>
              <input type="number" step="0.1" inputMode="decimal" value={t.cr??""} placeholder="—"
                onChange={e=>updTee(i,"cr",e.target.value===""?undefined:parseFloat(e.target.value))}
                style={cell}/></div>
            <div style={{flex:.8}}>
              <div style={miniLab}>PAR</div>
              <input type="number" inputMode="numeric" value={t.par??""} placeholder="72"
                onChange={e=>updTee(i,"par",+e.target.value)} style={cell}/></div>
            <div style={{flex:1}}>
              <div style={miniLab}>MÈTRES</div>
              <input type="number" inputMode="numeric" value={t.length||""} placeholder="—"
                onChange={e=>updTee(i,"length",+e.target.value||undefined)} style={cell}/></div>
          </div>
        </div>));})()}
      <button onClick={addTee} style={{...delBtn,width:"100%",padding:"8px",
        color:T.accent,borderColor:T.accent}}>+ Ajouter un départ</button>

      <HoleEditor c={c} upd={upd}/>
    </div>
  );
}

// Édition du par et du stroke index (HCP) trou par trou
function HoleEditor({c,upd}){
  const [open,setOpen]=useState(false);
  const pars=(c.pars&&c.pars.length===18)?c.pars:holePars(c);
  const si=(c.si&&c.si.length===18)?c.si:Array.from({length:18},(_,i)=>i+1);
  const setPar=(i,v)=>{const a=[...pars];a[i]=+v||0;upd(c.id,"pars",a);};
  const setSi=(i,v)=>{const a=[...si];a[i]=+v||0;upd(c.id,"si",a);};
  const Block=({from,to,label})=>(
    <div style={{marginBottom:10}}>
      <div style={{fontSize:10,color:T.dim,fontWeight:700,marginBottom:3}}>{label}</div>
      <table style={{borderCollapse:"collapse",width:"100%",tableLayout:"fixed",fontSize:11}}>
        <tbody>
          <tr><td style={{...td,textAlign:"left",color:T.dim,width:"14%"}}>Tr</td>
            {Array.from({length:to-from},(_,k)=><td key={k} style={{...td,color:T.dim}}>{from+k+1}</td>)}</tr>
          <tr><td style={{...td,textAlign:"left",color:T.dim}}>Par</td>
            {Array.from({length:to-from},(_,k)=>{const i=from+k;
              return <td key={i} style={{...td,padding:1}}>
                <input type="number" value={pars[i]} onChange={e=>setPar(i,e.target.value)}
                  style={{...cell,width:"100%",padding:"4px 0"}}/></td>;})}</tr>
          <tr><td style={{...td,textAlign:"left",color:T.gold}}>HCP</td>
            {Array.from({length:to-from},(_,k)=>{const i=from+k;
              return <td key={i} style={{...td,padding:1}}>
                <input type="number" value={si[i]} onChange={e=>setSi(i,e.target.value)}
                  style={{...cell,width:"100%",padding:"4px 0",borderColor:T.gold}}/></td>;})}</tr>
        </tbody>
      </table>
    </div>
  );
  return (
    <div style={{marginTop:10}}>
      <button onClick={()=>setOpen(!open)} style={{...miniBtn,width:"100%"}}>
        {open?"▲ Masquer":"▼ Modifier le Par et le HCP (coups rendus) trou par trou"}</button>
      {open&&<div style={{marginTop:10}}>
        <div style={{fontSize:11,color:T.dim,marginBottom:8,lineHeight:1.4}}>
          Corrige ici le <b>Par</b> et le <b>HCP</b> (stroke index : 1 = trou le plus dur,
          18 = le plus facile) d'après la vraie carte du parcours. Le HCP détermine les coups rendus.</div>
        <Block from={0} to={9} label="Aller · trous 1-9"/>
        <Block from={9} to={18} label="Retour · trous 10-18"/>
      </div>}
    </div>
  );
}

// Génère 5 parties de TEST déjà jouées (18 trous), variété de scores demandée :
// par, birdie, EAGLE, bogey, double et triple. Marquées test:true → hors classement.
function makeTestGames(members,courses){
  const co=courses.find(c=>/Nans/i.test(c.name||""))||courses[0];
  const cid=co?.id;
  const pars=(co?.pars&&co.pars.length===18)?co.pars:new Array(18).fill(4);
  const pool=members.filter(m=>m.member===true||/^seed-/.test(String(m.id))).slice(0,4)
    .map((m,i)=>({id:m.id,name:m.name,nick:m.nick||"",member:true,tee:"Jaune",
      index:(m.index&&m.index>0)?m.index:[12,18,24,8][i%4]}));
  if(pool.length<4) return []; // il faut au moins 4 joueurs préchargés
  // écarts au par sur 18 trous : 0 par · -1 birdie · -2 EAGLE · +1 bogey · +2 double · +3 triple
  const DELTAS=[0,-1,0,1,-1,0,2,-2,0,1,-1,3,0,1,2,-1,0,1];
  const scoreFor=(parH,pi,gi,h)=>Math.max(1,parH+DELTAS[(h+pi*3+gi*5)%18]);
  const buildScores=(ids,gi)=>{const s={};ids.forEach((id,pi)=>{s[id]={};
    for(let h=0;h<18;h++)s[id][h]=scoreFor(pars[h],pi,gi,h);});return s;};
  const P=pool.map(p=>p.id);
  const t=Date.now();
  const mk=(gi,formula,nIds,mode,team)=>{
    const ids=P.slice(0,nIds);
    const roster=pool.slice(0,nIds).map((p,i)=>({...p,
      team:team?(i<nIds/2?0:1):undefined}));
    return {id:t+gi,name:`🧪 TEST ${FORMULA_SHORT[formula]||formula}`,type:"simple",
      courseId:cid,mode,roster,test:true,done:true,created:t+gi,
      teamNames:team?["Équipe 1","Équipe 2"]:null,
      subgames:[{id:1,formula,players:ids,scores:buildScores(ids,gi),
        validated:Array.from({length:18},(_,i)=>i),done:true,hcpRelative:false}]};
  };
  return [
    mk(1,"matchplay",2,"net",false),
    mk(2,"chouette",3,"net",false),
    mk(3,"stableford",4,"net",false),
    mk(4,"fourball",4,"net",true),
    mk(5,"mexicaine",4,"gross",true),
  ];
}
// Construit une Ryder déjà jouée : l'équipe GAGNANTE (winners) bat l'équipe perdante (losers)
// via un match décisif (winners 3 partout, losers 6). Points : gagnants 3+5=8, perdants venus 1.
function buildRyder(winners,losers,wName,lName,courses){
  const co=courses.find(c=>/Nans/i.test(c.name||""))||courses[0];
  const mk=(p,team)=>({id:p.id,name:p.name,nick:p.nick||"",member:true,
    index:(p.index&&p.index>0)?p.index:18,tee:"Jaune",team});
  const roster=[...winners.map(p=>mk(p,0)),...losers.map(p=>mk(p,1))];
  const full=v=>{const o={};for(let h=0;h<18;h++)o[h]=v;return o;};
  const scores={}; winners.forEach(p=>scores[p.id]=full(3)); losers.forEach(p=>scores[p.id]=full(6));
  const subgames=[{id:1,formula:"stableford",players:[...winners,...losers].map(p=>p.id),scores,
    validated:Array.from({length:18},(_,k)=>k),done:true,hcpRelative:false}];
  const t=Date.now();
  return {id:t,name:`🏆 Ryder Cup · ${wName||"Gagnants"}`,type:"event",subtype:"ryder",mode:"net",roster,
    teamNames:[wName||"Gagnants",lName||"Perdants"],hats:[],hcpRelative:false,done:true,created:t,
    rounds:[{id:1,courseId:co?.id,courseName:co?.name||"Parcours",subgames,done:true}]};
}
// Pré-remplissage par défaut (Rory+Scottie+Passe Partout gagnants vs Fortnite+Trichatard+JiP).
function defaultRyderTeams(members){
  const find=re=>members.find(m=>re.test(m.nick||"")||re.test(m.name||""));
  const w=[/rory/i,/scottie/i,/passe.?partout/i].map(find).filter(Boolean);
  const l=[/fortnite/i,/trichatard/i,/jip|jean.?p/i].map(find).filter(Boolean);
  return {w,l};
}
// Formulaire de création d'une Ryder : noms d'équipes + qui est gagnant / perdant, puis valider.
function RyderBuilder({members,courses,onCreate,onCancel}){
  const pool=members.filter(m=>m.name&&m.name.trim()&&m.name.trim().toLowerCase()!=="invité")
    .sort((a,b)=>dispName(a).localeCompare(dispName(b)));
  const def=defaultRyderTeams(members);
  const [wName,setWName]=useState("Les Winner");
  const [lName,setLName]=useState("Les Gentils");
  const [assign,setAssign]=useState(()=>{const a={};
    def.w.forEach(p=>a[p.id]="W"); def.l.forEach(p=>a[p.id]="L"); return a;});
  const set=(id,v)=>setAssign(a=>({...a,[id]:a[id]===v?undefined:v}));
  const winners=pool.filter(p=>assign[p.id]==="W"), losers=pool.filter(p=>assign[p.id]==="L");
  const create=()=>{
    if(winners.length<1||losers.length<1) return alert("Mets au moins 1 joueur dans chaque équipe.");
    onCreate(buildRyder(winners,losers,wName.trim()||"Gagnants",lName.trim()||"Perdants",courses));
  };
  return (<div style={{...card(T.gold),marginBottom:10}}>
    <div style={{fontWeight:800,marginBottom:8}}>🏆 Créer une Ryder</div>
    <div style={{display:"flex",gap:8,marginBottom:8}}>
      <label style={{flex:1}}><span style={{fontSize:10,color:T.eu}}>ÉQUIPE GAGNANTE</span>
        <input value={wName} onChange={e=>setWName(e.target.value)} style={{...inp,marginTop:2}}/></label>
      <label style={{flex:1}}><span style={{fontSize:10,color:T.us}}>ÉQUIPE PERDANTE</span>
        <input value={lName} onChange={e=>setLName(e.target.value)} style={{...inp,marginTop:2}}/></label>
    </div>
    <div style={{fontSize:11,color:T.dim,marginBottom:6}}>Affecte chaque joueur (gagnant = +8, perdant venu = +1) :</div>
    {pool.map(p=>{const v=assign[p.id];return (
      <div key={p.id} style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}>
        <span style={{flex:1,minWidth:0,fontWeight:700,fontSize:13,whiteSpace:"nowrap",
          overflow:"hidden",textOverflow:"ellipsis"}}>{dispName(p)}</span>
        <button onClick={()=>set(p.id,"W")} style={{...chip,padding:"5px 10px",fontSize:12,
          border:`2px solid ${v==="W"?T.eu:T.line}`,background:v==="W"?T.eu+"22":T.panel,
          color:v==="W"?T.text:T.dim,fontWeight:v==="W"?800:600}}>Gagnant</button>
        <button onClick={()=>set(p.id,"L")} style={{...chip,padding:"5px 10px",fontSize:12,
          border:`2px solid ${v==="L"?T.us:T.line}`,background:v==="L"?T.us+"22":T.panel,
          color:v==="L"?T.text:T.dim,fontWeight:v==="L"?800:600}}>Perdant</button>
      </div>);})}
    <div style={{display:"flex",gap:8,marginTop:10}}>
      <button onClick={create} style={{...addBtn,flex:1,margin:0,background:T.gold,color:"#1a1200"}}>✅ Valider & attribuer les points</button>
      <button onClick={onCancel} style={{...delBtn,flexShrink:0}}>Annuler</button>
    </div>
  </div>);
}
function History({openId,onConsumeOpen}){
  const {user,games,setGames,members,courses,removeGame,admin,cloud,cleanupDuplicates,clearAllGames}=useContext(Ctx);
  const [open,setOpen]=useState(openId||null);
  const [showRyder,setShowRyder]=useState(false);
  const [scope,setScope]=useState("mine"); // "mine" = mes parties · "all" = toutes
  const [cleaning,setCleaning]=useState("");
  const mine=g=>(g.roster||[]).some(p=>String(p.id)===String(user?.id));
  const shown=scope==="mine"?games.filter(mine):games;
  const loadDemos=()=>{
    const demos=makeTestGames(members,courses);
    if(!demos.length) return alert("Il faut au moins 4 joueurs préchargés pour générer les parties de test.");
    if(!confirm("Charger 5 parties de TEST (match play, chouette, stableford, fourball, mexicaine) déjà jouées ?\nElles sont marquées 🧪 TEST et ne comptent pas au classement.")) return;
    setGames([...demos,...games]); setScope("all");
  };
  const onCreateRyder=(game)=>{ setGames([game,...games]); setShowRyder(false); setScope("all"); };
  const doCleanup=async()=>{ setCleaning("…");
    const n=await cleanupDuplicates();
    setCleaning(n>0?`✅ ${n} doublon(s) supprimé(s)`:"✅ Aucun doublon");
    setTimeout(()=>setCleaning(""),3000); };
  const doClearAll=async()=>{
    if(!confirm("Supprimer DÉFINITIVEMENT TOUTES les parties et repartir à zéro ?\n(le classement sera vidé — utile pour effacer les parties de test)")) return;
    if(!confirm("Es-tu sûr ? Cette action est irréversible.")) return;
    await clearAllGames(); };
  useEffect(()=>{ if(openId){ setOpen(openId); onConsumeOpen&&onConsumeOpen(); } },[openId]);
  const isMember=p=>p.member===true||/^seed-/.test(String(p.id));
  const delGame=(id,e)=>{e.stopPropagation();
    const g=games.find(x=>x.id===id); if(!g) return;
    // une partie VALIDÉE contenant des membres = protégée : seul l'organisateur peut la supprimer
    // (les parties de test ne sont pas protégées : elles ne comptent pas au classement)
    if(g.done && !g.test && (g.roster||[]).some(isMember) && !admin){
      alert("🔒 Cette partie validée fait partie du championnat : seul l'organisateur peut la supprimer.");
      return;}
    if(confirm("Supprimer définitivement cette partie de l'historique ?")) removeGame(g);};
  if(open){const g=games.find(x=>x.id===open);
    if(g) return <GameDetail g={g} members={members} courses={courses} games={games}
      setGames={setGames} back={()=>setOpen(null)}/>;}
  return (<div><Section>Parties ({shown.length})</Section>
    {/* sélecteur slide : mes parties / toutes */}
    <div style={{display:"flex",background:T.panel,borderRadius:999,padding:3,marginBottom:10}}>
      {[["mine","🏌️ Mes parties"],["all","🌍 Toutes"]].map(([k,lab])=>(
        <button key={k} onClick={()=>setScope(k)} style={{flex:1,padding:"9px 6px",borderRadius:999,
          border:"none",cursor:"pointer",fontWeight:800,fontSize:12,transition:"all .15s",
          background:scope===k?T.accent:"transparent",color:scope===k?T.ink:T.dim}}>{lab}</button>))}
    </div>
    {admin&&showRyder&&<RyderBuilder members={members} courses={courses}
      onCreate={onCreateRyder} onCancel={()=>setShowRyder(false)}/>}
    {admin&&<div style={{marginBottom:10,display:"flex",flexDirection:"column",gap:6}}>
      <button onClick={loadDemos} style={{...delBtn,width:"100%",fontSize:12,
        borderColor:T.violet,color:T.violet}}>🧪 Charger 5 parties de test (hors classement)</button>
      {!showRyder&&<button onClick={()=>setShowRyder(true)} style={{...delBtn,width:"100%",fontSize:12,
        borderColor:T.gold,color:T.gold}}>🏆 Créer une Ryder (équipes modifiables)</button>}
      {cloud&&<button onClick={doCleanup} style={{...delBtn,width:"100%",fontSize:12,
        borderColor:T.gold,color:T.gold}}>🧹 Nettoyer les doublons (réparer le classement)</button>}
      {cleaning&&<div style={{fontSize:11,color:T.accent,textAlign:"center"}}>{cleaning}</div>}
      <button onClick={doClearAll} style={{...delBtn,width:"100%",fontSize:12,
        borderColor:T.us,color:T.us}}>🗑️ Tout supprimer · repartir à zéro (test → vraie saison)</button>
    </div>}
    {!shown.length && <Empty text={scope==="mine"?"Aucune partie à ton nom. Bascule sur « Toutes » ou crée-en une.":"Aucune partie. Crée-en une depuis l'accueil."}/>}
    {shown.map(g=>{const ryder=g.subtype==="ryder";return (<div key={g.id} onClick={()=>setOpen(g.id)}
      style={{...card(g.test?T.violet:ryder?T.gold:g.done?T.accent:T.gold),cursor:"pointer",
        display:"flex",alignItems:"center",gap:8,
        ...(ryder?{border:`2px solid ${T.gold}`,background:`${T.gold}14`,
          boxShadow:`0 0 0 1px ${T.gold}33`}:{})}}>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontWeight:800,whiteSpace:"nowrap",overflow:"hidden",
          textOverflow:"ellipsis",color:ryder?T.gold:T.text}}>
          {g.test&&<span style={{fontSize:9,fontWeight:800,color:T.violet,border:`1px solid ${T.violet}`,
            borderRadius:6,padding:"1px 5px",marginRight:6}}>TEST</span>}{ryder&&"🏆 "}{g.name}</div>
        <div style={{fontSize:11,color:T.dim,whiteSpace:"nowrap",overflow:"hidden",
          textOverflow:"ellipsis"}}>
          {g.type==="event"?(g.subtype==="ryder"?"🏆 Ryder Cup":g.subtype==="coupe"?"🥊 MiniCup":"🏅 MiniChamp"):"⛳ Partie amicale"}
          {" · "}{(g.roster||[]).map(p=>dispName(p)).join(", ")}
          {" · "}{g.done?"terminé":"en cours"} · tap pour ouvrir</div>
      </div>
      <button onClick={e=>delGame(g.id,e)} style={{...delBtn,flexShrink:0}}>🗑</button>
    </div>);})}</div>);
}

// Choix du scoreur d'UNE sous-partie (flight). Chaque partie qui se joue désigne le
// sien : seul lui saisit cette partie, les autres la suivent en lecture seule.
function ScorerPicker({sg,label,players,scorerId,canEdit,myId,onPick,playerById}){
  return (
    <div style={{...card(T.violet),marginBottom:10}}>
      <div style={{fontWeight:800,marginBottom:6}}>
        ✍️ Qui tient la carte ?{label?<span style={{color:T.gold}}> · {label}</span>:null}</div>
      <div style={{fontSize:11,color:T.dim,marginBottom:8}}>
        Le scoreur de cette partie saisit ses scores. Les autres la suivent en direct (lecture seule).</div>
      <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
        {players.map(p=>{const isS=String(scorerId)===String(p.id);
          return (<button key={p.id} onClick={()=>onPick(p.id)}
            style={{padding:"7px 12px",borderRadius:999,cursor:"pointer",
              border:`1.5px solid ${isS?T.accent:T.line}`,
              background:isS?T.accent:T.panel,color:isS?T.ink:T.text,
              fontWeight:800,fontSize:12}}>
            {isS?"✍️ ":""}{dispName(p)}</button>);})}
      </div>
      {scorerId&&!canEdit&&<div style={{fontSize:11,color:T.gold,marginTop:8}}>
        👀 Lecture seule — {dispName(playerById(scorerId))} tient cette carte.</div>}
      {scorerId&&canEdit&&<div style={{fontSize:11,color:T.accent,marginTop:8}}>
        ✍️ C'est toi qui tiens cette carte.</div>}
    </div>
  );
}

// Reconfigurer une amicale à >4 joueurs APRÈS création (ex. passer de 2+4 à 3+3),
// tant qu'aucun score n'est saisi. Choix de la config + formules + affectation des joueurs.
function ReconfigPanel({g,save}){
  const roster=g.roster||[];
  const hasScores=(g.subgames||[]).some(sg=>Object.values(sg.scores||{})
    .some(h=>h&&Object.keys(h).length));
  const [openP,setOpenP]=useState(false);
  const [sizes,setSizes]=useState((g.subgames||[]).map(sg=>(sg.players||[]).length));
  const [formulas,setFormulas]=useState((g.subgames||[]).map(sg=>sg.formula));
  const seqMap=ss=>{const m={};let i=0;ss.forEach((sz,gi)=>{for(let k=0;k<sz;k++){const p=roster[i++];if(p)m[p.id]=gi;}});return m;};
  const [flightOf,setFlightOf]=useState(()=>{const m={};(g.subgames||[]).forEach((sg,gi)=>(sg.players||[]).forEach(id=>m[id]=gi));return m;});
  const flightOfP=id=>flightOf[id]??0;
  const cnt=gi=>roster.filter(p=>flightOfP(p.id)===gi).length;
  const pick=ns=>{setSizes(ns);setFormulas(ns.map((s,i)=>sizes[i]===s?formulas[i]:defaultFormula(s)));setFlightOf(seqMap(ns));};
  const setF=(gi,val)=>setFormulas(formulas.map((x,k)=>k===gi?val:x));
  const apply=()=>{
    const bad=sizes.findIndex((sz,gi)=>cnt(gi)!==sz);
    if(bad>=0) return alert(`La partie ${bad+1} doit compter ${sizes[bad]} joueurs (actuellement ${cnt(bad)}).`);
    const subgames=sizes.map((sz,gi)=>({id:gi+1,formula:formulas[gi]||defaultFormula(sz),
      players:roster.filter(p=>flightOfP(p.id)===gi).map(p=>p.id),
      scores:{},validated:[],done:false,hcpRelative:g.hcpRelative}));
    save({...g,subgames,teamNames:null}); setOpenP(false);
  };
  const n=roster.length;
  return (<div style={{...card(T.violet),marginBottom:12}}>
    <button onClick={()=>setOpenP(o=>!o)} style={{background:"none",border:"none",color:T.violet,
      fontWeight:800,fontSize:13,cursor:"pointer",width:"100%",textAlign:"left",padding:0}}>
      ⚙️ Reconfigurer les parties (ex. 3+3 au lieu de 2+4) {openP?"▲":"▼"}</button>
    {openP&&(hasScores
      ? <div style={{fontSize:12,color:T.gold,marginTop:8}}>⚠️ Des scores sont déjà saisis : impossible de reconfigurer sans les perdre. Rouvre une nouvelle partie si besoin.</div>
      : <div style={{marginTop:10}}>
          <ConfigPicker n={n} current={sizes.map(s=>({size:s}))} onPick={pick}/>
          {sizes.map((sz,gi)=>(<div key={gi} style={{marginBottom:6}}>
            <div style={{fontSize:11,color:cnt(gi)===sz?T.dim:T.gold}}>Partie {gi+1} · {sz} joueurs ({cnt(gi)}/{sz})</div>
            <select value={formulas[gi]||defaultFormula(sz)} onChange={e=>setF(gi,e.target.value)} style={{...inp,marginTop:2}}>
              {formulasFor(sz).map(f=><option key={f} value={f}>{FORMULA_LABELS[f]}</option>)}</select>
          </div>))}
          <div style={{fontSize:11,color:T.dim,margin:"6px 0 4px"}}>Affecte les joueurs (tape pour déplacer) :</div>
          {roster.map(p=>(<div key={p.id} style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}>
            <span style={{flex:1,minWidth:0,fontWeight:700,fontSize:13,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{dispName(p)}</span>
            <div style={{display:"flex",gap:4,flexShrink:0}}>
              {sizes.map((sz,gi)=>{const act=flightOfP(p.id)===gi;
                return <button key={gi} onClick={()=>setFlightOf(o=>({...o,[p.id]:gi}))}
                  style={{...chip,padding:"5px 9px",fontSize:12,border:`2px solid ${act?T.accent:T.line}`,
                  background:act?T.panel2:T.panel,color:act?T.text:T.dim,fontWeight:act?800:600}}>P{gi+1}</button>;})}
            </div></div>))}
          <button onClick={apply} style={{...addBtn,marginTop:8}}>✅ Appliquer la configuration</button>
        </div>)}
  </div>);
}
function GameDetail({g,members,courses,games,setGames,back}){
  const {user}=useContext(Ctx);
  const isTournament=!!g.rounds;
  const playerById=id=>g.roster.find(p=>p.id===id)||members.find(m=>m.id===id);
  const save=ng=>setGames(games.map(x=>x.id===g.id?ng:x));
  // Scoreur DÉSIGNÉ PAR SOUS-PARTIE (flight) : chaque partie qui se joue a son propre
  // scoreur. On ne peut saisir QUE sa propre partie, pas "celle de derrière".
  const myId=user?.id;
  const setScorerSimple=(sgId,pid)=>save({...g,subgames:g.subgames.map(sg=>
    sg.id!==sgId?sg:{...sg,scorerId:sg.scorerId===pid?null:pid})});
  const setScorerRound=(rid,sgId,pid)=>save({...g,rounds:g.rounds.map(r=>
    r.id!==rid?r:{...r,subgames:r.subgames.map(sg=>
      sg.id!==sgId?sg:{...sg,scorerId:sg.scorerId===pid?null:pid})})});
  // scoreur effectif d'une sous-partie (rétro-compat : ancien scoreur global pour une amicale à 1 flight)
  const scorerOf=sg=>sg.scorerId!=null?sg.scorerId
    :((g.subgames&&g.subgames.length===1)?g.scorerId:undefined);
  // qui peut saisir CETTE sous-partie ? son scoreur. Si aucun scoreur défini, tout le monde peut.
  const canEditSub=sg=>{const s=scorerOf(sg);return !s||String(s)===String(myId);};
  // la sous-partie où JE suis (joueur ou scoreur) : on n'affiche que celle-là à la saisie
  const isMine=sg=>(sg.players||[]).some(id=>String(id)===String(myId))
    ||String(scorerOf(sg))===String(myId);
  const [showAll,setShowAll]=useState(false);
  const [openMatch,setOpenMatch]=useState(undefined); // undefined=auto(ma partie) · null=liste · "clé"=une partie
  const [showSetup,setShowSetup]=useState(false);     // équipes & confrontations (replié par défaut)
  const setTeam=(pid,team)=>save({...g,roster:g.roster.map(p=>p.id===pid?{...p,team}:p)});
  // Tirage appliqué : équipes + chapeaux + PROPOSITION de confrontations par manche
  const applyDraw=({assign,hats})=>{
    const ng={...g,roster:g.roster.map(p=>assign[p.id]!==undefined?{...p,team:assign[p.id]}:p),hats};
    save({...ng,rounds:buildConfrontations(ng)});
  };
  // Régénérer les confrontations (mêmes chapeaux) — pour reproposer / après édition manuelle
  const regenConfrontations=()=>save({...g,rounds:buildConfrontations(g)});
  // COUPE (bracket) : lancer le tirage du tour 1, puis générer le tour suivant
  const launchCoupe=()=>save({...g,rounds:drawCoupe(g.roster,g.coupeFormula||"matchplay",g.courseId,g.hcpRelative)});
  const advanceCoupe=()=>{const nr=nextCoupeRound(g,courses);if(nr)save({...g,rounds:nr});};
  const renameTeam=(i,name)=>save({...g,teamNames:g.teamNames.map((t,j)=>j===i?name:t)});
  const [view,setView]=useState(g.done?"score":"briefing");
  // changer la formule d'un flight de tournoi (laisse la main après le tirage proposé)
  const setSubFormula=(rid,sgId,formula)=>save({...g,rounds:g.rounds.map(r=>
    r.id!==rid?r:{...r,subgames:r.subgames.map(sg=>sg.id!==sgId?sg:{...sg,formula})})});
  // changer la formule d'une sous-partie d'amicale (avant le 1er trou validé)
  const setSubFormulaSimple=(sgId,formula)=>save({...g,subgames:g.subgames.map(sg=>
    sg.id!==sgId?sg:{...sg,formula})});

  // --- édition scores : amicale (subgames) ou tournoi (rounds[].subgames) ---
  const setScoreSimple=(sgId,pid,hole,v)=>save({...g,subgames:g.subgames.map(sg=>{
    if(sg.id!==sgId) return sg;const sc={...sg.scores};sc[pid]={...(sc[pid]||{})};
    sc[pid][hole]=v===""?undefined:Math.max(1,+v);return {...sg,scores:sc};})});
  const setScoreRound=(rid,sgId,pid,hole,v)=>save({...g,rounds:g.rounds.map(r=>{
    if(r.id!==rid) return r;return {...r,subgames:r.subgames.map(sg=>{
      if(sg.id!==sgId) return sg;const sc={...sg.scores};sc[pid]={...(sc[pid]||{})};
      sc[pid][hole]=v===""?undefined:Math.max(1,+v);return {...sg,scores:sc};})};})});
  // validation d'un trou (toggle) → met à jour sg.validated
  const toggleHoleSimple=(sgId,hole)=>save({...g,subgames:g.subgames.map(sg=>{
    if(sg.id!==sgId) return sg;const v=sg.validated||[];
    return {...sg,validated:v.includes(hole)?v.filter(x=>x!==hole):[...v,hole]};})});
  const toggleHoleRound=(rid,sgId,hole)=>save({...g,rounds:g.rounds.map(r=>{
    if(r.id!==rid) return r;return {...r,subgames:r.subgames.map(sg=>{
      if(sg.id!==sgId) return sg;const v=sg.validated||[];
      return {...sg,validated:v.includes(hole)?v.filter(x=>x!==hole):[...v,hole]};})};})});
  const toggleDone=()=>{
    const nd=!g.done;
    if(nd && !gameComplete(g)){ // on ne valide QUE si les 18 trous sont remplis pour tous
      const miss=incompleteSubs(g);
      alert("Impossible de valider : les 18 trous doivent être remplis pour tous les joueurs.\n\n"
        +(miss.length?("À terminer : "+miss.join(", ")):"Aucune manche n'est encore complète.")
        +"\n\nTant qu'une partie n'est pas terminée, elle ne compte pas au classement.");
      return;
    }
    if(isTournament) save({...g,done:nd,
      rounds:g.rounds.map(r=>({...r,done:nd,subgames:r.subgames.map(s=>({...s,done:nd}))}))});
    else save({...g,done:nd,subgames:g.subgames.map(s=>({...s,done:nd}))});
  };

  const refCourse=courses.find(c=>c.id===(isTournament?g.rounds[0]?.courseId:g.courseId));
  return (
    <div>
      <button onClick={back} style={{...delBtn,marginBottom:8}}>← Retour</button>
      <Section>{g.name}</Section>
      <div style={{fontSize:12,color:T.dim,marginBottom:8}}>
        {isTournament?`${g.rounds.length} manche(s)`:refCourse?.name} ·
        {g.mode==="net"?" Net":" Brut"} · {g.roster?.length} joueurs</div>

      <div style={{display:"flex",gap:8,marginBottom:12}}>
        <Pill active={view==="briefing"} onClick={()=>setView("briefing")}>📋 Briefing</Pill>
        <Pill active={view==="score"} onClick={()=>setView("score")}>✏️ Scores</Pill>
        <Pill active={view==="evo"} onClick={()=>setView("evo")}>📈 Suivi score</Pill>
      </div>

      {view==="briefing" && <Briefing g={g} course={refCourse} courses={courses} playerById={playerById}
        onStart={()=>setView("score")}/>}

      {view==="evo" && (()=>{
        const blocks=isTournament
          ? g.rounds.flatMap(r=>r.subgames.map(sg=>({sg,course:courses.find(c=>c.id===r.courseId),
              label:`Manche ${r.id}${r.subgames.length>1?` · partie ${r.subgames.indexOf(sg)+1}`:""}`})))
          : (g.subgames||[]).map((sg,i)=>({sg,course:refCourse,
              label:g.subgames.length>1?`Partie ${i+1}`:null}));
        const visible=blocks.filter(b=>(b.sg.players||[]).length>=2);
        if(!visible.length) return <Empty text="Pas encore de manche à suivre."/>;
        return <>
          {visible.map(({sg,course,label})=>(
            <div key={sg.id} style={{marginBottom:14}}>
              {label&&<div style={{fontFamily:"Anton",fontSize:13,color:T.dim,marginBottom:2}}>{label}</div>}
              <EvolutionChart sg={sg} ps={sg.players.map(playerById).filter(Boolean)}
                course={course} net={g.mode==="net"}/>
            </div>))}
        </>;
      })()}

      {view==="score" && (()=>{
        const allSubs=isTournament?g.rounds.flatMap(r=>r.subgames):(g.subgames||[]);
        // Liste des PARTIES (sous-parties), chacune avec sa clé / son parcours / sa manche.
        const matches=isTournament
          ? g.rounds.flatMap(r=>r.subgames.map(sg=>({key:`${r.id}.${sg.id}`,sg,rid:r.id,
              rc:courses.find(c=>c.id===r.courseId),
              label:`Manche ${r.id}${r.subgames.length>1?` · Partie ${r.subgames.indexOf(sg)+1}`:""}`})))
          : (g.subgames||[]).map((sg,i)=>({key:`${sg.id}`,sg,rid:null,rc:refCourse,
              label:g.subgames.length>1?`Partie ${i+1}`:"La partie"}));
        const useList = matches.length>1 && g.subtype!=="coupe";
        // rendu épuré de la SAISIE d'une partie (formule + scoreur + grille)
        const renderScoring=(m)=>{const {sg,rid,rc}=m;
          const setF = rid!=null ? v=>setSubFormula(rid,sg.id,v) : v=>setSubFormulaSimple(sg.id,v);
          const setSc = rid!=null ? (sid,pid,h,v)=>setScoreRound(rid,sid,pid,h,v) : setScoreSimple;
          const valH = rid!=null ? (sid,h)=>toggleHoleRound(rid,sid,h) : toggleHoleSimple;
          const setScr = rid!=null ? pid=>setScorerRound(rid,sg.id,pid) : pid=>setScorerSimple(sg.id,pid);
          return (<div key={m.key}>
            {!g.done&&(sg.validated||[]).length===0&&<div style={{...card(T.eu),marginBottom:8}}>
              <div style={{fontSize:10,color:T.dim,marginBottom:4,textTransform:"uppercase",
                letterSpacing:.5,fontWeight:700}}>🎲 Formule (modifiable avant le 1er trou)</div>
              <select value={sg.formula} onChange={e=>setF(e.target.value)} style={{...inp,marginTop:0}}>
                {formulasFor(sg.players.length).map(f=><option key={f} value={f}>{FORMULA_LABELS[f]}</option>)}</select></div>}
            {!g.done&&<ScorerPicker sg={sg} label={null} scorerId={scorerOf(sg)} canEdit={canEditSub(sg)} myId={myId}
              players={sg.players.map(playerById).filter(Boolean)} onPick={setScr} playerById={playerById}/>}
            <SubGame sg={sg} course={rc} mode={g.mode} playerById={playerById}
              setScore={setSc} validateHole={valH} done={g.done||!canEditSub(sg)}/>
          </div>);};
        // bandeau de contrôles (tirage, équipes, reconfig) — niveau « vue d'ensemble »
        const teamsFormed=g.roster.some(p=>p.team===0||p.team===1);
        const overview=<>
          {/* tirage : visible tant que les équipes ne sont pas formées */}
          {g.subtype==="ryder"&&!g.done&&!teamsFormed&&<DrawHats g={g} onAssign={applyDraw}/>}
          {/* équipes & confrontations : REPLIÉ par défaut (n'encombre plus l'onglet Score) */}
          {g.type==="event"&&g.subtype!=="coupe"&&teamsFormed&&!g.done&&(
            <div style={{...card(T.line),marginBottom:12}}>
              <button onClick={()=>setShowSetup(s=>!s)} style={{background:"none",border:"none",
                color:T.text,fontWeight:800,fontSize:13,cursor:"pointer",width:"100%",
                textAlign:"left",padding:0,display:"flex",justifyContent:"space-between"}}>
                <span>⚙️ Équipes & confrontations</span><span style={{color:T.dim}}>{showSetup?"▲":"▼ modifier"}</span></button>
              {showSetup&&<div style={{marginTop:10}}>
                {(g.hats||[]).length>0&&<button onClick={regenConfrontations}
                  style={{...delBtn,width:"100%",marginBottom:10,fontSize:12,borderColor:T.gold,color:T.gold}}>
                  🔄 Re-tirer les confrontations (nouveau tirage aléatoire)</button>}
                <TeamManager g={g} renameTeam={renameTeam} setTeam={setTeam}/>
              </div>}
            </div>)}
          {!isTournament && (g.roster||[]).length>4 && !g.done && <ReconfigPanel g={g} save={save}/>}
        </>;
        const validateBtn=<button onClick={toggleDone} style={{...addBtn,background:g.done?T.line:T.accent,
          color:g.done?T.text:"#04150b"}}>{g.done?"↩ Rouvrir":"✅ Valider (révéler résultats)"}</button>;
        const boards=<>
          {g.subtype==="ryder"&&<RyderBoard g={g} courses={courses} playerById={playerById}/>}
          {g.type==="event"&&g.subtype!=="ryder"&&g.subtype!=="coupe"&&g.done&&<EventBoard g={g} courses={courses} playerById={playerById}/>}
          {g.done&&<ShareResults g={g} courses={courses} playerById={playerById}/>}
        </>;

        // ===== COUPE : flux bracket existant + saisie de ma partie courante =====
        if(g.subtype==="coupe"){
          const mine=allSubs.filter(isMine);const cur=mine.find(sg=>!subComplete(sg))||mine[mine.length-1];
          const m=matches.find(x=>x.sg===cur);
          return <>
            {(!g.rounds||!g.rounds.length)&&!g.done&&(
              <div style={{...card(T.gold),marginBottom:12,textAlign:"center"}}>
                <div style={{fontWeight:800,marginBottom:4}}>🏆 MiniCup · {FORMULA_SHORT[g.coupeFormula]||"Match Play"}</div>
                <div style={{fontSize:11,color:T.dim,marginBottom:10}}>
                  {g.roster?.length} joueurs · tirage aléatoire en 1v1 (élimination directe).</div>
                <button onClick={launchCoupe} style={{...addBtn,margin:0,
                  background:`linear-gradient(90deg,${T.eu},${T.us})`,color:"#fff"}}>🎲 LANCER LE TIRAGE</button>
              </div>)}
            {g.rounds?.length>0&&<BracketBoard g={g} courses={courses} playerById={playerById}/>}
            {!g.done&&g.rounds?.length>0&&nextCoupeRound(g,courses)&&
              <button onClick={advanceCoupe} style={{...addBtn,marginBottom:12,
                background:T.gold,color:"#1a1200"}}>▶️ Valider et générer le tour suivant</button>}
            {m&&renderScoring(m)}
            {validateBtn}{boards}
          </>;
        }

        // ===== MULTI-PARTIES : LISTE des parties ↔ DÉTAIL d'une partie =====
        if(useList){
          // tant que les équipes d'une Ryder ne sont pas tirées, on reste sur la liste (tirage visible)
          const needsSetup = g.subtype==="ryder" && !g.roster.some(p=>p.team===0||p.team===1);
          const myMatch=matches.find(m=>isMine(m.sg)&&!subComplete(m.sg))||matches.find(m=>isMine(m.sg));
          const sel = openMatch!==undefined ? openMatch : (needsSetup ? null : (myMatch?myMatch.key:null));
          const openM = matches.find(m=>m.key===sel);
          if(openM){ // DÉTAIL d'une partie
            return <>
              <button onClick={()=>setOpenMatch(null)} style={{...delBtn,marginBottom:10}}>← Toutes les parties</button>
              <div style={{fontFamily:"Anton",fontSize:16,marginBottom:8,display:"flex",
                alignItems:"center",gap:8}}>
                <span style={{background:T.gold,color:"#1a1200",borderRadius:6,padding:"2px 8px",fontSize:13}}>{openM.label}</span>
                <span style={{fontSize:12,color:T.dim}}>{openM.rc?.name}</span></div>
              {renderScoring(openM)}
            </>;
          }
          // LISTE des parties + scoreboard
          return <>
            {overview}
            <Section>Parties ({matches.length})</Section>
            {matches.map(m=>{
              const complete=subComplete(m.sg),started=(m.sg.validated||[]).length>0;
              const st=complete?{t:"✅ Terminé",c:T.accent}:started?{t:"⏳ En cours",c:T.gold}:{t:"À venir",c:T.dim};
              const ps=m.sg.players.map(playerById).filter(Boolean);
              const res=started?computeSub(m.sg,ps,m.rc,g.mode==="net"):null;
              return (<div key={m.key} onClick={()=>setOpenMatch(m.key)}
                style={{...card(st.c),cursor:"pointer",display:"flex",flexDirection:"column",gap:3}}>
                <div style={{display:"flex",justifyContent:"space-between",gap:8,alignItems:"center"}}>
                  <span style={{fontWeight:800,fontSize:13}}>{m.label} · {FORMULA_SHORT[m.sg.formula]||m.sg.formula}
                    {isMine(m.sg)&&<span style={{fontSize:9,color:T.accent,border:`1px solid ${T.accent}`,
                      borderRadius:6,padding:"1px 5px",marginLeft:6}}>TOI</span>}</span>
                  <span style={{fontSize:11,color:st.c,fontWeight:700,flexShrink:0}}>{st.t}</span></div>
                <div style={{fontSize:11,color:T.dim,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                  {ps.map(dispName).join(" · ")}</div>
                {res&&<div style={{fontSize:12,color:T.text,fontWeight:700}}>{res.summary}</div>}
                {!g.done&&<div style={{fontSize:10,color:T.accent}}>tap pour {complete?"revoir":"saisir"} →</div>}
              </div>);})}
            {validateBtn}{boards}
          </>;
        }

        // ===== PARTIE SIMPLE (1 flight) : saisie directe =====
        return <>{overview}{matches.map(m=>renderScoring(m))}{validateBtn}{boards}</>;
      })()}
    </div>
  );
}

// Partage des résultats via WhatsApp / SMS / partage natif (gratuit, sans service tiers)
function ShareResults({g,courses,playerById}){
  const {games}=useContext(Ctx);
  const impact=seasonImpact(g,games,courses);
  const buildText=()=>{
    const net=g.mode==="net";
    const isTournament=!!g.rounds;
    const kind=g.subtype==="ryder"?"🏆 Ryder Cup"
      :g.subtype==="coupe"?"🥊 MiniCup"
      :isTournament?"🏅 MiniChamp"
      :"⛳ Partie amicale";
    const D="—————————————";
    let t=`${kind}\n${g.name}\n${net?"Net":"Brut"}\n${D}\n`;
    const subs=g.rounds
      ? g.rounds.flatMap(r=>r.subgames.map(sg=>({sg,c:courses.find(x=>x.id===r.courseId),rid:r.id})))
      : g.subgames.map(sg=>({sg,c:courses.find(x=>x.id===g.courseId)}));
    let curRound=null;
    subs.forEach(({sg,c,rid})=>{
      // en-tête de manche seulement s'il y a plusieurs manches (tournoi/ryder)
      if(isTournament && rid!==curRound){
        t+=`${curRound!==null?"\n":""}🚩 Manche ${rid} · ${c?.name}\n`;curRound=rid;
      }
      const ps=sg.players.map(playerById).filter(Boolean);
      const r=computeSub(sg,ps,c,net);
      if(r)t+=`🎲 ${FORMULA_LABELS[sg.formula]}\n→ ${r.summary}\n\n`;
      // 👤 Fiche par joueur : médaille (ordre du résultat de la formule) + Stableford brut/net
      const allH=Array.from({length:18},(_,i)=>i);
      const {pts:fpts}=playerScores(sg,ps,c,net);
      const fiche=ps.map(p=>({p,brut:stablefordBrut(sg,p,c,allH),net:stablefordNet(sg,p,c,allH),
        f:fpts?.[p.id]||0})).sort((x,y)=>y.f-x.f||y.net-x.net);
      const med=["🥇","🥈","🥉"];
      fiche.forEach((x,i)=>{const m=med[i]||"";
        t+=`👤 ${dispName(x.p)}${m?" "+m:""} · Stab ${x.brut} brut / ${x.net} net\n`;});
      // coups rendus par joueur (si partie en net)
      if(net && c){
        const cr=ps.map(p=>{
          const chp=effChp(p,ps,c,sg.hcpRelative);
          return `${dispName(p)} ${chp}`;}).join(" · ");
        t+=`🎯 Coups rendus : ${cr}\n`;
      }
      t+=`\n`;
    });
    if(g.type==="event"){
      let t0=0,t1=0;
      subs.forEach(({sg,c})=>{const ps=sg.players.map(playerById).filter(Boolean);
        const {pts}=playerScores(sg,ps,c,net);
        Object.entries(pts).forEach(([id,pt])=>{const p=g.roster.find(x=>String(x.id)===String(id));
          if(p?.team===0)t0+=pt;else if(p?.team===1)t1+=pt;});});
      const [n0,n1]=g.teamNames||["Équipe 1","Équipe 2"];
      const lead=t0>t1?`🏆 ${n0} l'emporte !`:t1>t0?`🏆 ${n1} l'emporte !`:"🤝 Égalité parfaite !";
      t+=`${D}\n${n0}  ${t0} – ${t1}  ${n1}\n${lead}\n`;
    }
    // 🏅 Impact sur le classement de saison (points gagnés + nouveau total/rang)
    if(!impact.counted){
      t+=`${D}\n⚖️ Partie hors classement (moins de 2 membres G&A)\n`;
    } else if(impact.lines.length){
      t+=`${D}\n🏅 Classement de saison\n`;
      impact.lines.forEach(l=>{const p=playerById(l.id);
        const prog=l.isNew?" (NEW)":l.delta>0?` ▲${l.delta}`:l.delta<0?` ▼${-l.delta}`:" =";
        t+=`   ${dispName(p)}  +${l.gained} → ${l.total} pts${l.rank?`  #${l.rank}`:""}${prog}\n`;});
    }
    t+=`${D}\n⛳ Du Golf & des Amis`;
    return t.trim();
  };
  const share=async()=>{
    const text=buildText();
    if(navigator.share){try{await navigator.share({title:g.name,text});return;}catch(e){}}
    // repli : ouvre WhatsApp avec le texte pré-rempli
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`,"_blank");
  };
  const waLink=DB.lget("waGroup",DEFAULT_WA);
  const toGroup=()=>{
    // copie le résultat puis ouvre le groupe WhatsApp pour le coller
    try{navigator.clipboard?.writeText(buildText());}catch(e){}
    window.open(waLink,"_blank");
  };
  return (
    <div style={{marginTop:14}}>
      {!impact.counted && (
        <div style={{...card(T.line),marginBottom:12,fontSize:12,color:T.dim,lineHeight:1.5}}>
          ⚖️ <b style={{color:T.text}}>Partie hors classement</b> — il faut au moins
          {" "}<b style={{color:T.text}}>2 membres G&A</b> dans une même confrontation pour
          marquer des points de saison. (Vous avez quand même tous vos résultats du jour 👍)</div>
      )}
      {impact.counted && impact.lines.length>0 && (
        <div style={{...card(T.gold),marginBottom:12}}>
          <div style={{fontWeight:800,marginBottom:8}}>🏅 Évolution au classement de saison</div>
          {impact.lines.map((l,i)=>{const p=playerById(l.id);
            const medal=l.rank===1?"🥇":l.rank===2?"🥈":l.rank===3?"🥉":`#${l.rank||"-"}`;
            return (<div key={l.id} style={{display:"flex",alignItems:"center",gap:8,
              padding:"7px 0",borderTop:i?`1px solid ${T.line}`:"none"}}>
              <span style={{width:26,textAlign:"center",fontWeight:800,fontSize:15,
                color:l.rank<=3?T.gold:T.dim}}>{medal}</span>
              <span style={{flex:1,fontWeight:700}}>{dispName(p)}</span>
              <span style={{fontSize:11,fontWeight:800,width:36,textAlign:"center",
                color:l.isNew?T.gold:l.delta>0?T.accent:l.delta<0?T.us:T.dim}}>
                {l.isNew?"NEW":l.delta>0?`▲${l.delta}`:l.delta<0?`▼${-l.delta}`:"="}</span>
              <span style={{color:T.accent,fontWeight:800,fontSize:13,width:34,textAlign:"right"}}>+{l.gained}</span>
              <span style={{color:T.dim,fontSize:12,width:54,textAlign:"right"}}>{l.total} pts</span>
            </div>);})}
          <div style={{fontSize:10,color:T.dim,marginTop:6}}>
            Rang général · ▲/▼ places gagnées cette partie · points gagnés · total.</div>
        </div>
      )}
      <button onClick={share} style={{...addBtn,background:"#25D366",color:"#062b14"}}>
        💬 Partager les résultats sur WhatsApp</button>
      {waLink&&<button onClick={toGroup} style={{...delBtn,width:"100%",marginTop:8,
        padding:"12px",borderColor:"#25D366",color:"#25D366"}}>
        📋 Copier & ouvrir le groupe du club</button>}
      <div style={{fontSize:10,color:T.dim,marginTop:6,textAlign:"center"}}>
        Le résultat est pré-rempli — tu choisis le contact ou le groupe, et tu envoies.
        {waLink?" (Le 2e bouton copie le texte puis ouvre votre groupe : il ne reste qu'à coller.)":""}</div>
    </div>
  );
}

/* ===== VUE BRIEFING : récap coups rendus, slope/SSS, départs, trous rendus ===== */
// Tableau du parcours trou par trou (Par + Longueur + HCP) affiché dans le briefing.
function HolesBriefing({course}){
  const pars=holePars(course);
  const si=(course?.si&&course.si.length===18)?course.si:Array.from({length:18},(_,i)=>i+1);
  const len=(course?.lengths&&course.lengths.length===18)?course.lengths:null;
  const totLen=course?.length||(len?len.reduce((a,b)=>a+(b||0),0):null);
  const td={border:`1px solid ${T.line}`,padding:"3px 1px",textAlign:"center"};
  const Block=({from,to,label})=>{
    const idx=Array.from({length:to-from},(_,k)=>from+k);
    const sp=idx.reduce((a,i)=>a+(pars[i]||0),0);
    const sl=len?idx.reduce((a,i)=>a+(len[i]||0),0):null;
    return (
      <table style={{borderCollapse:"collapse",width:"100%",tableLayout:"fixed",
        fontSize:11,marginBottom:8}}>
        <tbody>
          <tr><td style={{...td,textAlign:"left",color:T.dim,width:"13%"}}>{label}</td>
            {idx.map(i=><td key={i} style={{...td,color:T.dim}}>{i+1}</td>)}
            <td style={{...td,color:T.gold,fontWeight:800}}>Σ</td></tr>
          <tr><td style={{...td,textAlign:"left",color:T.dim}}>Par</td>
            {idx.map(i=><td key={i} style={td}>{pars[i]}</td>)}
            <td style={{...td,fontWeight:800}}>{sp}</td></tr>
          <tr><td style={{...td,textAlign:"left",color:T.accent}}>m</td>
            {idx.map(i=><td key={i} style={td}>{len?len[i]:"—"}</td>)}
            <td style={{...td,fontWeight:800,color:T.accent}}>{sl??"—"}</td></tr>
          <tr><td style={{...td,textAlign:"left",color:T.gold}}>HCP</td>
            {idx.map(i=><td key={i} style={td}>{si[i]}</td>)}
            <td style={td}></td></tr>
        </tbody>
      </table>
    );
  };
  return (
    <div style={{...card(T.line),marginBottom:14}}>
      <div style={{fontWeight:800,marginBottom:8}}>📋 Le parcours trou par trou
        {totLen?<span style={{color:T.accent,fontWeight:700}}> · {totLen} m</span>:null}</div>
      <Block from={0} to={9} label="Aller"/>
      <Block from={9} to={18} label="Retour"/>
    </div>
  );
}

function Briefing({g,course,courses,playerById,onStart}){
  const net=g.mode==="net";
  const rel=!!g.hcpRelative; // coups rendus en différentiel (match play)
  const teamNames=g.teamNames||null;
  // Les flights (sous-parties), CHACUN avec son parcours. ⚠️ Le différentiel se calcule
  // PAR FLIGHT : le plus bas de CETTE partie joue à 0, pas le plus bas de tout le champ.
  const flights = g.rounds
    ? g.rounds.flatMap(r=>r.subgames.map((sg,i)=>({sg,
        course:(courses||[]).find(c=>c.id===r.courseId)||course,
        label:`Manche ${r.id}${r.subgames.length>1?` · Partie ${i+1}`:""}`})))
    : (g.subgames||[]).map((sg,i)=>({sg,course,
        label:(g.subgames.length>1?`Partie ${i+1}`:null)}));
  const flightRows=({sg,course:co})=>{
    const ps=(sg.players||[]).map(playerById).filter(Boolean);
    const base=ps.map(p=>{const t=teeData(co,p.tee);
      return {p,t,raw:courseHandicap(p.index,t.slope,t.cr,t.par)};});
    const minChp=base.length?Math.min(...base.map(r=>r.raw)):0; // référence = plus bas DU FLIGHT
    return base.map(({p,t,raw})=>{const chp=rel?raw-minChp:raw;
      return {p,t,chp,holes:net?strokeHoles(chp,co?.si):[]};});
  };
  return (
    <div>
      <div style={{...card(T.accent)}}>
        <div style={{fontWeight:800,marginBottom:4}}>⛳ {course?.name}{g.rounds?` (+${g.rounds.length-1} manche${g.rounds.length>2?"s":""})`:""}</div>
        <div style={{fontSize:12,color:T.dim}}>
          Par {course?.par} · {g.mode==="net"?"Jeu en NET (coups rendus)":"Jeu en BRUT"}
          {g.mode==="net"&&g.hcpRelative?" · 🆚 différentiel (match play)":g.mode==="net"?" · intégral":""}</div>
      </div>

      {/* ÉQUIPES (Ryder / tournoi par équipes) — affichées dans le brief */}
      {teamNames && g.roster.some(p=>p.team===0||p.team===1) && (
        <div style={{display:"flex",gap:8,marginTop:10}}>
          {[0,1].map(ti=>(
            <div key={ti} style={{flex:1,...card(ti===0?T.eu:T.us)}}>
              <div style={{fontWeight:800,fontSize:13,marginBottom:4}}>{teamNames[ti]}</div>
              {g.roster.filter(p=>p.team===ti).map(p=>(
                <div key={p.id} style={{fontSize:12,color:T.text}}>{dispName(p)} <span style={{color:T.dim,fontSize:10}}>({p.index})</span></div>))}
            </div>))}
        </div>)}

      {course && <HolesBriefing course={course}/>}

      <Section>Coups rendus {rel?"(différentiel · par partie)":"par joueur"}</Section>
      {flights.map(({sg,course:co,label},fi)=>{
        const rows=flightRows({sg,course:co});
        if(!rows.length) return null;
        return (<div key={fi} style={{marginBottom:6}}>
          {label && <div style={{fontSize:11,fontWeight:800,color:T.gold,margin:"8px 0 4px"}}>
            {label}{co&&g.rounds?` · ${co.name}`:""}</div>}
          {rows.map(({p,t,chp,holes})=>(
            <div key={p.id} style={{...card(p.team===0?T.eu:p.team===1?T.us:T.line)}}>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{width:12,height:12,borderRadius:3,background:teeDot(p.tee),
                  border:`1px solid ${T.line}`}}/>
                <span style={{fontWeight:800,flex:1}}>{dispName(p)}</span>
                <span style={{fontFamily:"Anton",fontSize:22,color:T.gold}}>{net?chp:0}</span>
              </div>
              <div style={{fontSize:11,color:T.dim,marginTop:4}}>
                Index de jeu {p.index} · départ {p.tee} (SSS {t.cr} · Slope {t.slope})</div>
              {net && <div style={{marginTop:8}}>
                <div style={{fontSize:11,color:T.dim,marginBottom:4}}>
                  {chp<=0?"🟢 Joueur de référence (0 coup rendu)":`Reçoit ${chp} coup(s) sur :`}</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                  {holes.map(h=>(<span key={h.hole} style={{fontSize:11,padding:"3px 7px",
                    borderRadius:6,background:T.panel2,fontWeight:700}}>
                    Trou {h.hole}{h.n>1?` ×${h.n}`:""}</span>))}
                  {holes.length===0 && <span style={{fontSize:11,color:T.dim}}>aucun</span>}
                </div></div>}
            </div>))}
        </div>);
      })}
      <button onClick={onStart} style={{...addBtn,fontFamily:"'Archivo',sans-serif",fontSize:16,letterSpacing:.5}}>C'EST PARTI → SAISIR LES SCORES</button>
    </div>
  );
}

function TeamManager({g,renameTeam,setTeam}){
  const [name0,setName0]=useState(g.teamNames?.[0]||"Équipe 1");
  const [name1,setName1]=useState(g.teamNames?.[1]||"Équipe 2");
  return (
    <div style={{...card(T.gold),marginBottom:14}}>
      <div style={{fontWeight:800,marginBottom:8}}>Équipes (renommables)</div>
      <div style={{display:"flex",gap:8,marginBottom:10}}>
        <input value={name0} onChange={e=>setName0(e.target.value)}
          onBlur={()=>renameTeam(0,name0)} style={{...inp,borderColor:T.eu}}/>
        <input value={name1} onChange={e=>setName1(e.target.value)}
          onBlur={()=>renameTeam(1,name1)} style={{...inp,borderColor:T.us}}/>
      </div>
      {g.roster.map(p=>(
        <div key={p.id} style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
          <span style={{width:9,height:9,borderRadius:2,background:teeDot(p.tee),flexShrink:0}}/>
          <span style={{flex:1,fontSize:13,fontWeight:700}}>{dispName(p)}
            <span style={{color:T.dim,fontWeight:400}}> · {p.tee}</span>
            {p.team==null&&<span style={{color:T.gold,fontWeight:400,fontSize:10}}> · neutre</span>}</span>
          <button onClick={()=>setTeam(p.id,p.team===0?null:0)} style={{...miniBtn,
            background:p.team===0?T.eu:T.panel,borderColor:T.eu}}>{name0}</button>
          <button onClick={()=>setTeam(p.id,p.team===1?null:1)} style={{...miniBtn,
            background:p.team===1?T.us:T.panel,borderColor:T.us}}>{name1}</button>
        </div>))}
      <div style={{fontSize:11,color:T.dim,marginTop:4}}>
        {g.subtype==="ryder"?"Lance le tirage ci-dessus, ou tape pour affecter à la main. ":
          "Tape pour affecter / désaffecter. "}Non affectés = neutres.</div>
    </div>
  );
}

// Couleur d'un score selon l'écart au par : par = vert ; sous le par = bleu (de plus en
// plus clair vers l'eagle) ; bogey = orange ; double bogey et + = rouge.
function scoreColor(d){
  if(d===0) return T.accent;                        // par → vert
  if(d>0) return d===1?"#ff9f43":"#ff5b5b";         // bogey → orange · double+ → rouge
  const blues=["#4c8dff","#6ba6ff","#94c2ff","#bcd9ff"]; // birdie · eagle · albatros · +
  return blues[Math.min(-d-1,blues.length-1)];
}
function SubGame({sg,course,mode,playerById,setScore,validateHole,done}){
  const ps=sg.players.map(playerById).filter(Boolean);
  const net=mode==="net";
  const result=useMemo(()=>computeSub(sg,ps,course,net),[sg,ps,course,net]);
  const pars=holePars(course);
  const validated=sg.validated||[];
  const isValid=h=>validated.includes(h);
  const [pad,setPad]=useState(null); // {pid,hole} cellule en cours de saisie
  const [showGrid,setShowGrid]=useState(false); // grille complète dépliée
  const [curHole,setCurHole]=useState(()=>{ // 1er trou non validé
    for(let i=0;i<18;i++) if(!(sg.validated||[]).includes(i)) return i; return 0;});
  const strokesByPlayer={};
  ps.forEach(p=>{
    const chp=effChp(p,ps,course,sg.hcpRelative);
    strokesByPlayer[p.id]=net?strokesPerHole(chp,course?.si):new Array(18).fill(0);});
  const allScored=h=>ps.every(p=>sg.scores?.[p.id]?.[h]!=null);
  const padPlayer=pad?ps.find(p=>p.id===pad.pid):null;
  const enter=(n)=>{ if(!pad) return; setScore(sg.id,pad.pid,pad.hole,String(n));
    setPad(null); // referme : le pavé se replacera au prochain clic, pile sur la case
  };
  const siOf=h=>(course?.si&&course.si.length===18)?course.si[h]:h+1;

  // ===== VUE TROU PAR TROU (par défaut) =====
  if(!showGrid && !done){
    const h=curHole, v=isValid(h);
    return (
      <div style={{...card(T.eu),marginBottom:14}}>
        <div style={{fontWeight:800,marginBottom:8}}>{FORMULA_LABELS[sg.formula]} ·
          {" "}{ps.map(p=>dispName(p)).join(" / ")}</div>

        {/* navigation trou */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",
          marginBottom:10}}>
          <button onClick={()=>{setCurHole(Math.max(0,h-1));setPad(null);}}
            disabled={h===0} style={{...miniBtn,padding:"8px 14px",opacity:h===0?.4:1}}>◀</button>
          <div style={{textAlign:"center"}}>
            <div style={{fontFamily:"Anton",fontSize:26,lineHeight:1}}>Trou {h+1}</div>
            <div style={{fontSize:11,color:T.dim,marginTop:2}}>
              Par {pars[h]} · HCP {siOf(h)} {v&&<span style={{color:T.accent}}>· ✓ validé</span>}</div>
          </div>
          <button onClick={()=>{setCurHole(Math.min(17,h+1));setPad(null);}}
            disabled={h===17} style={{...miniBtn,padding:"8px 14px",opacity:h===17?.4:1}}>▶</button>
        </div>

        {/* lignes joueurs : nom + case score */}
        {ps.map(p=>{
          const recv=strokesByPlayer[p.id][h]>0;
          const val=sg.scores?.[p.id]?.[h];
          const vsPar=val!=null?val-pars[h]:null;
          const active=pad&&pad.pid===p.id&&pad.hole===h;
          return (
            <div key={p.id} style={{display:"flex",alignItems:"center",gap:10,
              padding:"8px 10px",marginBottom:6,borderRadius:12,
              background:active?`${T.accent}14`:T.panel,
              border:`1.5px solid ${active?T.accent:T.line}`}}>
              <span style={{width:9,height:9,borderRadius:2,background:teeDot(p.tee),flexShrink:0}}/>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:700,fontSize:14}}>{dispName(p)}
                  {recv&&<span style={{color:"#3a7bd5",fontSize:11}}> ●{strokesByPlayer[p.id][h]>1?strokesByPlayer[p.id][h]:""} coup rendu</span>}</div>
                <div style={{fontSize:10,color:T.dim}}>CHP {net?effChp(p,ps,course,sg.hcpRelative):0}</div>
              </div>
              <button disabled={v} onClick={(e)=>{
                  if(active){setPad(null);return;}
                  const r=e.currentTarget.getBoundingClientRect();
                  setPad({pid:p.id,hole:h,x:r.left+r.width/2,y:r.bottom});
                }}
                style={{width:54,height:54,borderRadius:14,fontSize:22,fontWeight:800,
                  fontFamily:"Anton",cursor:v?"default":"pointer",
                  border:`2px solid ${active?T.accent:val!=null?scoreColor(vsPar):T.line}`,
                  background:active?`${T.accent}22`:"#0c130e",opacity:v?.6:1,
                  color:val!=null?scoreColor(vsPar):T.text}}>{val??"–"}</button>
            </div>
          );
        })}

        {/* pavé 1→9 FLOTTANT, pile près du doigt, recalé dans l'écran */}
        {pad && padPlayer && pad.hole===h && (()=>{
          const PADW=232, PADH=168, M=8;
          const vw=typeof window!=="undefined"?window.innerWidth:380;
          const vh=typeof window!=="undefined"?window.innerHeight:700;
          let left=(pad.x||vw/2)-PADW/2;
          left=Math.max(M,Math.min(left,vw-PADW-M));
          let top=(pad.y||vh/2)+8;                    // sous la case par défaut
          if(top+PADH>vh-M) top=Math.max(M,(pad.y||vh/2)-PADH-60); // sinon au-dessus
          return (<>
            <div onClick={()=>setPad(null)} style={{position:"fixed",inset:0,zIndex:40}}/>
            <div style={{position:"fixed",left,top,width:PADW,zIndex:41,
              background:T.panel2,borderRadius:14,padding:12,
              border:`1.5px solid ${T.accent}`,boxShadow:"0 10px 30px rgba(0,0,0,.5)"}}>
              <div style={{fontSize:11,color:T.dim,marginBottom:8,textAlign:"center"}}>
                <b style={{color:T.text}}>{dispName(padPlayer)}</b> · trou {h+1} (par {pars[h]})</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:6}}>
                {[1,2,3,4,5,6,7,8,9].map(n=>{const col=scoreColor(n-pars[h]);
                  return (<button key={n} onClick={()=>enter(n)} style={{padding:"12px 0",
                    borderRadius:10,border:`1.5px solid ${col}55`,background:`${col}1a`,color:col,
                    fontSize:17,fontWeight:800,fontFamily:"Anton",cursor:"pointer"}}>{n}</button>);})}
                <button onClick={()=>setPad(null)} style={{padding:"12px 0",borderRadius:10,
                  border:`1.5px solid ${T.line}`,background:"transparent",color:T.dim,
                  fontSize:12,fontWeight:800,cursor:"pointer"}}>✕</button>
              </div>
            </div>
          </>);
        })()}

        {/* bouton valider le trou */}
        <button onClick={()=>{validateHole(sg.id,h); if(!v&&h<17){setCurHole(h+1);setPad(null);}}}
          disabled={!v&&!allScored(h)}
          style={{...addBtn,marginTop:12,
            background:v?T.gold:allScored(h)?T.accent:T.line,
            color:v?"#1a1200":allScored(h)?T.ink:T.dim}}>
          {v?"🔒 Rouvrir ce trou":"✓ Valider le trou"+(h<17?" et passer au suivant":"")}</button>

        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
          marginTop:10,fontSize:11,color:T.dim}}>
          <span>{validated.length}/18 trous validés</span>
          <button onClick={()=>setShowGrid(true)} style={{...miniBtn,fontSize:11}}>
            📋 Voir la grille complète</button>
        </div>

        <LiveBoard sg={sg} ps={ps} course={course} net={net} result={result}/>
      </div>
    );
  }

  return (
    <div style={{...card(T.eu),marginBottom:14}}>
      <div style={{fontWeight:800,marginBottom:6}}>{FORMULA_LABELS[sg.formula]} ·
        {" "}{ps.map(p=>dispName(p)).join(" / ")}</div>
      {!done && <button onClick={()=>setShowGrid(false)} style={{...miniBtn,marginBottom:8}}>
        ← Revenir à la saisie trou par trou</button>}
      <div style={{fontSize:10,color:T.dim,marginBottom:4}}>
        Tape une case → choisis le score · 🔵 coup rendu · HCP = difficulté · ✓ valide · 🔒 rouvrir</div>
      {(()=>{
        const Block=({from,to,label})=>(
          <div style={{marginBottom:14}}>
            <div style={{fontSize:10,color:T.dim,fontWeight:700,marginBottom:4,
              textTransform:"uppercase",letterSpacing:.5}}>{label}</div>
            <table style={{borderCollapse:"collapse",fontSize:11,width:"100%",tableLayout:"fixed"}}>
              <thead>
                <tr><th style={{...th,width:"15%",textAlign:"left"}}>Tr</th>
                  {Array.from({length:to-from},(_,k)=>{const i=from+k;const v=isValid(i);
                    return (<th key={i} style={{...th,background:v?"#143d28":"transparent",
                      color:v?T.accent:T.dim,borderRadius:4}}>{i+1}{v&&"✓"}</th>);})}
                  <th style={{...th,color:T.gold}}>T</th></tr>
                <tr><td style={{...td,color:T.dim,fontSize:9,fontWeight:700,textAlign:"left"}}>HCP</td>
                  {Array.from({length:to-from},(_,k)=>{const i=from+k;const si=siOf(i);
                    return <td key={i} style={{...td,color:si<=6?"#ff9b9b":si<=12?T.gold:T.dim,
                      fontSize:9,fontWeight:700}}>{si}</td>;})}
                  <td style={td}></td></tr>
                <tr><td style={{...td,color:T.dim,fontSize:9,textAlign:"left"}}>Par</td>
                  {Array.from({length:to-from},(_,k)=>{const i=from+k;
                    return <td key={i} style={{...td,color:T.dim,fontSize:9}}>{pars[i]}</td>;})}
                  <td style={{...td,fontSize:9,color:T.dim}}>
                    {pars.slice(from,to).reduce((a,b)=>a+b,0)}</td></tr>
              </thead>
              <tbody>{ps.map(p=>{
                const t=teeData(course,p.tee);const chp=courseHandicap(p.index,t.slope,t.cr,t.par);
                const sub=Array.from({length:to-from},(_,k)=>sg.scores?.[p.id]?.[from+k])
                  .reduce((a,b)=>a+(b||0),0);
                return (<tr key={p.id}>
                  <td style={{...td,fontWeight:700,whiteSpace:"nowrap",textAlign:"left",fontSize:10}}>
                    <span style={{display:"inline-block",width:7,height:7,borderRadius:2,
                      background:teeDot(p.tee),marginRight:3}}/>{dispName(p)}</td>
                  {Array.from({length:to-from},(_,k)=>{const i=from+k;
                    const recv=strokesByPlayer[p.id][i]>0;const v=isValid(i);
                    const val=sg.scores?.[p.id]?.[i];const vsPar=val!=null?val-pars[i]:null;
                    const active=pad&&pad.pid===p.id&&pad.hole===i;
                    return (<td key={i} style={{...td,position:"relative",padding:"2px 1px",
                      background:v?"#10311f":"transparent"}}>
                      <button disabled={v||done} onClick={(e)=>{
                          if(active){setPad(null);return;}
                          const r=e.currentTarget.getBoundingClientRect();
                          setPad({pid:p.id,hole:i,x:r.left+r.width/2,y:r.bottom});}}
                        style={{...cell,width:"100%",cursor:(v||done)?"default":"pointer",
                          borderColor:active?T.accent:recv?"#3a7bd5":T.line,
                          borderWidth:active?2:1.5,opacity:v?.6:1,
                          background:active?`${T.accent}22`:"#0c130e",
                          color:val!=null?scoreColor(vsPar):T.text}}>{val??""}</button>
                      {recv&&<span style={{position:"absolute",top:0,right:1,width:4,height:4,
                        borderRadius:"50%",background:"#3a7bd5"}}/>}
                    </td>);})}
                  <td style={{...td,fontWeight:800,color:T.gold}}>{sub||"-"}</td></tr>);
              })}</tbody>
              {!done && <tfoot>
                <tr><td style={{...td,color:T.dim,fontSize:8,textAlign:"left"}}>OK</td>
                  {Array.from({length:to-from},(_,k)=>{const i=from+k;
                    const v=isValid(i),ok=allScored(i);
                    return (<td key={i} style={{...td,padding:"3px 1px"}}>
                      <button onClick={()=>validateHole(sg.id,i)} disabled={!v&&!ok}
                        style={{width:"100%",padding:"3px 0",borderRadius:5,
                          cursor:(v||ok)?"pointer":"default",border:"none",fontSize:10,fontWeight:800,
                          background:v?T.gold:ok?T.accent:"#1a2620",
                          color:v?"#1a1200":ok?T.ink:T.dim}}>{v?"🔒":"✓"}</button></td>);})}
                  <td style={td}></td></tr>
              </tfoot>}
            </table>
          </div>
        );
        return (<><Block from={0} to={9} label="Aller · trous 1 à 9"/>
          <Block from={9} to={18} label="Retour · trous 10 à 18"/></>);
      })()}

      {/* pavé flottant 1→9 (mode grille) */}
      {pad && padPlayer && (()=>{
        const PADW=232,PADH=168,M=8;
        const vw=typeof window!=="undefined"?window.innerWidth:380;
        const vh=typeof window!=="undefined"?window.innerHeight:700;
        let left=(pad.x||vw/2)-PADW/2; left=Math.max(M,Math.min(left,vw-PADW-M));
        let top=(pad.y||vh/2)+8; if(top+PADH>vh-M) top=Math.max(M,(pad.y||vh/2)-PADH-50);
        return (<>
          <div onClick={()=>setPad(null)} style={{position:"fixed",inset:0,zIndex:40}}/>
          <div style={{position:"fixed",left,top,width:PADW,zIndex:41,background:T.panel2,
            borderRadius:14,padding:12,border:`1.5px solid ${T.accent}`,
            boxShadow:"0 10px 30px rgba(0,0,0,.5)"}}>
            <div style={{fontSize:11,color:T.dim,marginBottom:8,textAlign:"center"}}>
              <b style={{color:T.text}}>{dispName(padPlayer)}</b> · trou {pad.hole+1} (par {pars[pad.hole]})</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:6}}>
              {[1,2,3,4,5,6,7,8,9].map(n=>{const diff=n-pars[pad.hole];
                const col=diff<0?T.accent:diff===0?T.text:diff===1?T.gold:"#ff9b9b";
                return (<button key={n} onClick={()=>enter(n)} style={{padding:"12px 0",
                  borderRadius:10,border:`1.5px solid ${col}55`,background:`${col}1a`,color:col,
                  fontSize:17,fontWeight:800,fontFamily:"Anton",cursor:"pointer"}}>{n}</button>);})}
              <button onClick={()=>setPad(null)} style={{padding:"12px 0",borderRadius:10,
                border:`1.5px solid ${T.line}`,background:"transparent",color:T.dim,
                fontSize:12,fontWeight:800,cursor:"pointer"}}>✕</button>
            </div>
          </div>
        </>);
      })()}

      <div style={{fontSize:11,color:T.dim,marginTop:8}}>
        {validated.length}/18 trous validés · le classement live ne compte que les trous validés</div>
      {/* TABLEAU RÉSULTATS LIVE */}
      <LiveBoard sg={sg} ps={ps} course={course} net={net} result={result}/>
      {done&&result&&<div style={{marginTop:8,padding:"8px 10px",background:T.panel2,
        borderRadius:8,fontSize:13}}>🏁 Final : {result.summary}</div>}
    </div>
  );
}

/* ===== Tableau de résultats live, visuel, sous la saisie ===== */
function stablefordBrut(sg,p,course,validated){
  // barème brut : eagle+ 4 / birdie 3 / par 2 / bogey 1 / double+ 0
  const pars=holePars(course);let pts=0;
  validated.forEach(h=>{const g=sg.scores?.[p.id]?.[h];if(g==null)return;
    const d=g-pars[h]; // vs par (brut)
    pts+=d<=-2?4:d===-1?3:d===0?2:d===1?1:0;});
  return pts;
}
function stablefordNet(sg,p,course,validated){
  // stableford NET : score net = brut - coups rendus (handicap de jeu absolu du joueur)
  const chp=effChp(p,[p],course,false);
  const strokes=strokesPerHole(chp,course?.si||[]);
  const pars=holePars(course);let pts=0;
  validated.forEach(h=>{const g=sg.scores?.[p.id]?.[h];if(g==null)return;
    const s=g-(strokes[h]||0),d=s-pars[h];
    pts+=d<=-2?4:d===-1?3:d===0?2:d===1?1:0;});
  return pts;
}
/* ===== Série d'évolution de la CONFRONTATION (selon la formule), trou par trou =====
   - match play / fourball-like → MARGE (1 UP / All Square / 1 DOWN)
   - mexicaine, bestworst → points cumulés des 2 équipes
   - chouette → points cumulés par joueur · stableford/skins → points cumulés
   - 1v1v1 / stroke net → score net cumulé vs par (plus bas = mieux)
   On réutilise les calculs existants (computeSub) pour rester fidèle au score affiché. */
const EVO_PALETTE=["#3ddc84","#4c8dff","#ffd24a","#ff7b9c","#a78bfa","#ff9f43","#2dd4bf","#f9a8d4"];
function confrontationSeries(sg,ps,course,net){
  if(!course||ps.length<2) return null;
  const f=sg.formula;
  const validated=(sg.validated||[]).slice().sort((a,b)=>a-b);
  const useNet = f==="stableford_net"?true : f==="stableford_gross"?false : (net && !BRUT_ONLY.includes(f));
  const pars=holePars(course);
  const strokes={}; ps.forEach(p=>{strokes[p.id]=useNet?strokesPerHole(effChp(p,ps,course,sg.hcpRelative),course?.si||[]):new Array(18).fill(0);});
  const netOf=(p,h)=>{const g=sg.scores?.[p.id]?.[h];return g==null?null:g-(strokes[p.id][h]||0);};
  const dn=p=>dispName(p);

  // 1) MATCH PLAY (1v1) & fourball-like → courbe de MARGE (1 UP / AS / 1 DOWN)
  if(["matchplay","matchplay2v2","fourball","foursome","scramble","chamble"].includes(f)){
    const a=f==="matchplay"?[ps[0]]:ps.slice(0,2);
    const b=f==="matchplay"?[ps[1]]:ps.slice(2,4);
    const th=(team,h)=>{const v=team.map(p=>netOf(p,h)).filter(x=>x!=null);return v.length?Math.min(...v):null;};
    let win=0; const line=[];
    validated.forEach(h=>{const e=th(a,h),u=th(b,h);if(e!=null&&u!=null){if(e<u)win++;else if(u<e)win--;}line.push({h,v:win});});
    return {kind:"margin",labelA:a.map(dn).join(" / "),labelB:b.map(dn).join(" / "),line,sub:"Statut du match, trou par trou"};
  }

  // computeSub sur les seuls trous joués jusqu'à un point donné (logiques complexes réutilisées)
  const runAt=(holes)=>{const scores={};ps.forEach(p=>{scores[p.id]={};
    holes.forEach(h=>{const v=sg.scores?.[p.id]?.[h];if(v!=null)scores[p.id][h]=v;});});
    return computeSub({...sg,scores,validated:[...holes]},ps,course,net)||{};};

  // 2) MEXICAINE / BESTWORST → points cumulés des 2 équipes
  if(f==="mexicaine"||f==="bestworst"){
    const a=ps.slice(0,2),b=ps.slice(2,4),sA=[],sB=[];
    validated.forEach((h,i)=>{const r=runAt(validated.slice(0,i+1));
      sA.push({h,v:(f==="mexicaine"?r.mexA:r.teamA)||0});
      sB.push({h,v:(f==="mexicaine"?r.mexB:r.teamB)||0});});
    return {kind:"lines",unit:"pts",sub:"Points cumulés de la confrontation",
      series:[{name:a.map(dn).join("/"),pts:sA,color:EVO_PALETTE[0],total:sA.length?sA[sA.length-1].v:0},
              {name:b.map(dn).join("/"),pts:sB,color:EVO_PALETTE[1],total:sB.length?sB[sB.length-1].v:0}]};
  }

  // 3) CHOUETTE → points cumulés par joueur (4/2/0…)
  if(f==="chouette"){
    const acc={};ps.forEach(p=>acc[p.id]=[]);
    validated.forEach((h,i)=>{const r=runAt(validated.slice(0,i+1));ps.forEach(p=>acc[p.id].push({h,v:r.pts?.[p.id]||0}));});
    const series=ps.map((p,idx)=>({name:dn(p),pts:acc[p.id],color:EVO_PALETTE[idx%EVO_PALETTE.length],
      total:acc[p.id].length?acc[p.id][acc[p.id].length-1].v:0})).sort((a,b)=>b.total-a.total);
    return {kind:"lines",unit:"pts",sub:"Points cumulés (chouette)",series};
  }

  // 4) STABLEFORD → points cumulés par joueur
  if(["stableford","stableford_net","stableford_gross"].includes(f)){
    const parH=Math.round((course.par||72)/18);
    const series=ps.map((p,idx)=>{let cum=0;const pts=[];
      validated.forEach(h=>{const s=netOf(p,h);if(s!=null)cum+=Math.max(0,2+(parH-s));pts.push({h,v:cum});});
      return {name:dn(p),pts,color:EVO_PALETTE[idx%EVO_PALETTE.length],total:cum};}).sort((a,b)=>b.total-a.total);
    return {kind:"lines",unit:"pts",sub:`Stableford ${useNet?"net":"brut"} cumulé`,series};
  }

  // 5) SKINS → skins cumulés par joueur (report inclus)
  if(f==="skins"){
    const cum={};ps.forEach(p=>cum[p.id]=0);let carry=0;
    const acc={};ps.forEach(p=>acc[p.id]=[]);
    validated.forEach(h=>{const vals=ps.map(p=>({id:p.id,s:netOf(p,h)})).filter(x=>x.s!=null);
      if(vals.length){const min=Math.min(...vals.map(v=>v.s));const w=vals.filter(v=>v.s===min);
        if(w.length===1){cum[w[0].id]+=1+carry;carry=0;}else carry++;}
      ps.forEach(p=>acc[p.id].push({h,v:cum[p.id]}));});
    const series=ps.map((p,idx)=>({name:dn(p),pts:acc[p.id],color:EVO_PALETTE[idx%EVO_PALETTE.length],
      total:cum[p.id]})).sort((a,b)=>b.total-a.total);
    return {kind:"lines",unit:"skins",sub:"Skins cumulés (report inclus)",series};
  }

  // 6) 1v1v1 / stroke net / autres → score net cumulé vs par (plus bas = mieux)
  const series=ps.map((p,idx)=>{let cum=0;const pts=[];
    validated.forEach(h=>{const s=netOf(p,h);if(s!=null)cum+=(s-pars[h]);pts.push({h,v:cum});});
    return {name:dn(p),pts,color:EVO_PALETTE[idx%EVO_PALETTE.length],total:cum};}).sort((a,b)=>a.total-b.total);
  return {kind:"lines",unit:"vs par",lowerBetter:true,sub:"Score net cumulé vs par (plus bas = mieux)",series};
}
function EvolutionChart({sg,ps,course,net}){
  const data=confrontationSeries(sg,ps,course,net);
  const hasData=(sg.validated||[]).length>0 && data;
  const W=320,H=132,padL=8,padT=12,padB=20;
  const plotH=H-padT-padB;
  const Shell=({children,sub})=>(
    <div style={{marginTop:12,background:`linear-gradient(180deg,${T.panel2},${T.panel})`,
      borderRadius:12,padding:12,border:`1px solid ${T.line}`}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:8}}>
        <span style={{fontFamily:"Anton",fontSize:14,letterSpacing:.5}}>📈 SUIVI SCORE</span>
        <span style={{fontSize:10,color:T.dim}}>{sub}</span></div>
      {children}
    </div>);
  if(!hasData) return <Shell sub="confrontation"><div style={{fontSize:12,color:T.dim,
    textAlign:"center",padding:"8px 0"}}>Valide des trous (bouton ✓) pour voir la courbe se tracer…</div></Shell>;

  // ----- COURBE DE MARGE (match play) : 0 = All Square au centre -----
  if(data.kind==="margin"){
    const line=data.line;
    const cur=line.length?line[line.length-1].v:0;
    const maxAbs=Math.max(1,...line.map(p=>Math.abs(p.v)));
    const RP=20;                                  // marge droite pour l'échelle UP
    const Xm=h=>padL+(h/17)*(W-padL-RP);
    const mid=padT+plotH/2, Y=v=>mid-(v/maxAbs)*(plotH/2-4);
    const col=cur>0?T.eu:cur<0?T.us:T.dim;
    const status=cur>0?`${cur} UP · ${data.labelA}`:cur<0?`${-cur} UP · ${data.labelB}`:"All Square";
    const levels=[];for(let i=1;i<=maxAbs;i++)levels.push(i);
    return <Shell sub="Match play · trous d'avance (UP)">
      {/* nom du joueur/équipe du HAUT, aligné à droite */}
      <div style={{display:"flex",justifyContent:"flex-end",fontSize:11,fontWeight:800,color:T.eu}}>
        ▲ {data.labelA}</div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:"auto",display:"block"}}>
        <line x1={Xm(8.5)} y1={padT} x2={Xm(8.5)} y2={padT+plotH} stroke={T.line} strokeDasharray="3 3"/>
        {/* échelle UP à droite (1, 2, 3…) de part et d'autre du 0 */}
        {levels.map(i=>(<g key={i}>
          <line x1={padL} y1={Y(i)} x2={W-RP} y2={Y(i)} stroke={T.line} strokeOpacity=".45"/>
          <line x1={padL} y1={Y(-i)} x2={W-RP} y2={Y(-i)} stroke={T.line} strokeOpacity=".45"/>
          <text x={W-RP+3} y={Y(i)+3} fill={T.dim} fontSize="8">{i}</text>
          <text x={W-RP+3} y={Y(-i)+3} fill={T.dim} fontSize="8">{i}</text>
        </g>))}
        {/* ligne du 0 = All Square */}
        <line x1={padL} y1={mid} x2={W-RP} y2={mid} stroke={T.dim} strokeOpacity=".7" strokeDasharray="2 3"/>
        <text x={W-RP+3} y={mid+3} fill={T.dim} fontSize="7.5">AS</text>
        {/* courbe d'évolution (couleur = qui mène) */}
        <polyline fill="none" stroke={col} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round"
          points={line.map(p=>`${Xm(p.h)},${Y(p.v)}`).join(" ")}/>
        {line.length>0 && <circle cx={Xm(line[line.length-1].h)} cy={Y(cur)} r="3.2" fill={col}/>}
        {[0,8,17].map(h=>(<text key={h} x={Xm(h)} y={H-6} fill={T.dim} fontSize="9"
          textAnchor={h===0?"start":h===17?"end":"middle"}>{h+1}</text>))}
      </svg>
      {/* nom du joueur/équipe du BAS, aligné à droite */}
      <div style={{display:"flex",justifyContent:"flex-end",fontSize:11,fontWeight:800,color:T.us,marginTop:2}}>
        ▼ {data.labelB}</div>
      <div style={{textAlign:"center",marginTop:6,fontFamily:"Anton",fontSize:16,color:col}}>{status}</div>
    </Shell>;
  }

  // ----- COURBES À LIGNES (points/vs par) : repère orthonormé, abscisse = trous 1→18 -----
  const series=data.series;
  // l'axe Y épouse les valeurs réelles (on NE force PAS le 0 en bas → la courbe ne
  // « démarre » plus depuis 0, elle suit le score effectif).
  const allV=series.flatMap(s=>s.pts.map(p=>p.v));
  let vMax=allV.length?Math.max(...allV):1, vMin=allV.length?Math.min(...allV):0;
  if(vMax===vMin){vMax+=1;vMin-=1;}
  const LP=22, RP=12;                              // marges axes Y / fin de courbe
  const Xl=h=>LP+(h/17)*(W-LP-RP);
  const Y=v=>padT+plotH-((v-vMin)/(vMax-vMin))*plotH;
  const showZero=vMin<0&&vMax>0;
  const xs=series.find(s=>s.pts.length)?.pts||[];
  const lastH=xs.length?xs[xs.length-1].h:null;     // dernier trou validé
  const x0=padT+plotH;                              // y de l'axe des abscisses
  return <Shell sub={data.sub}>
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",height:"auto",display:"block"}}>
      {/* repère orthonormé : axe Y (gauche) + axe X (bas) */}
      <line x1={LP} y1={padT} x2={LP} y2={x0} stroke={T.line}/>
      <line x1={LP} y1={x0} x2={W-RP} y2={x0} stroke={T.line}/>
      {/* graduations Y : max / 0 / min */}
      <text x={LP-3} y={padT+4} fill={T.dim} fontSize="8" textAnchor="end">{Math.round(vMax)}</text>
      <text x={LP-3} y={x0} fill={T.dim} fontSize="8" textAnchor="end">{Math.round(vMin)}</text>
      {showZero && <><line x1={LP} y1={Y(0)} x2={W-RP} y2={Y(0)} stroke={T.dim} strokeOpacity=".4" strokeDasharray="2 3"/>
        <text x={LP-3} y={Y(0)+3} fill={T.dim} fontSize="8" textAnchor="end">0</text></>}
      {/* repère mi-parcours (trou 9) + marqueur du dernier trou validé */}
      <line x1={Xl(8.5)} y1={padT} x2={Xl(8.5)} y2={x0} stroke={T.line} strokeOpacity=".5" strokeDasharray="3 3"/>
      {lastH!=null && <line x1={Xl(lastH)} y1={padT} x2={Xl(lastH)} y2={x0} stroke={T.accent} strokeOpacity=".45" strokeDasharray="2 2"/>}
      {/* courbes */}
      {series.map((s,i)=>(<g key={i}>
        <polyline fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"
          points={s.pts.map(p=>`${Xl(p.h)},${Y(p.v)}`).join(" ")}/>
        {s.pts.length>0 && <circle cx={Xl(s.pts[s.pts.length-1].h)} cy={Y(s.pts[s.pts.length-1].v)} r="3" fill={s.color}/>}
      </g>))}
      {/* abscisse : trou 1, dernier trou validé (surbrillance), trou 18 */}
      <text x={Xl(0)} y={H-6} fill={T.dim} fontSize="9" textAnchor="start">1</text>
      <text x={Xl(17)} y={H-6} fill={T.dim} fontSize="9" textAnchor="end">18</text>
      {lastH!=null && lastH>1 && lastH<16 &&
        <text x={Xl(lastH)} y={H-6} fill={T.accent} fontSize="9" fontWeight="800" textAnchor="middle">{lastH+1}</text>}
    </svg>
    <div style={{display:"flex",flexWrap:"wrap",gap:"4px 12px",marginTop:8}}>
      {series.map((s,i)=>(
        <span key={i} style={{display:"flex",alignItems:"center",gap:5,fontSize:11}}>
          <span style={{width:12,height:3,borderRadius:2,background:s.color}}/>
          <span style={{color:T.text,fontWeight:700}}>{s.name}</span>
          <span style={{color:T.dim}}>{data.lowerBetter&&s.total>0?"+":""}{s.total}<span style={{fontSize:9}}> {data.unit}</span></span>
        </span>))}
    </div>
  </Shell>;
}
function LiveBoard({sg,ps,course,net,result}){
  const validated=(sg.validated||[]).slice().sort((a,b)=>a-b);
  const f=sg.formula;
  const sgV=useMemo(()=>{
    const scores={};ps.forEach(p=>{scores[p.id]={};
      validated.forEach(h=>{const v=sg.scores?.[p.id]?.[h];if(v!=null)scores[p.id][h]=v;});});
    return {...sg,scores};
  },[sg,validated.join(",")]);// eslint-disable-line
  const rV=useMemo(()=>computeSub(sgV,ps,course,net),[sgV,ps,course,net]);

  const teamFormats=["fourball","bestworst","foursome","mexicaine","scramble","chamble","matchplay2v2"];
  const isTeam2v2=teamFormats.includes(f) && ps.length===4;
  const anyValid=validated.length>0;

  // ===== Affichage spécial 2v2 : score d'équipe en évidence + Stableford brut individuel =====
  if(isTeam2v2){
    const a=ps.slice(0,2),b=ps.slice(2,4);
    const nameA=a.map(dispName).join(" / "),nameB=b.map(dispName).join(" / ");
    // joueurs triés par Stableford brut décroissant (informatif)
    const indiv=ps.map(p=>({p,team:a.includes(p)?0:1,
      stb:stablefordBrut(sg,p,course,validated)})).sort((x,y)=>y.stb-x.stb);
    const winA=rV?.winner===nameA, winB=rV?.winner===nameB;
    return (
      <div style={{marginTop:12,background:`linear-gradient(180deg,${T.panel2},${T.panel})`,
        borderRadius:12,padding:12,border:`1px solid ${T.line}`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <span style={{fontFamily:"Anton",fontSize:14,letterSpacing:.5}}>📊 RÉSULTATS LIVE</span>
          <span style={{fontSize:10,color:T.dim}}>{validated.length} tr. validés</span></div>
        {!anyValid && <div style={{fontSize:12,color:T.dim,textAlign:"center",padding:"8px 0"}}>
          Valide des trous (bouton ✓) pour voir le résultat d'équipe…</div>}
        {/* SCORE D'ÉQUIPE EN ÉVIDENCE */}
        {anyValid && <div style={{display:"flex",gap:10,marginBottom:12}}>
          {[{n:nameA,win:winA,c:T.eu},{n:nameB,win:winB,c:T.us}].map((t,i)=>(
            <div key={i} style={{flex:1,borderRadius:14,padding:"14px 10px",textAlign:"center",
              border:`2px solid ${t.win?T.gold:t.c+"55"}`,
              background:t.win?`${T.gold}1a`:`${t.c}14`}}>
              <div style={{fontSize:12,fontWeight:800,color:t.win?T.gold:T.text}}>
                {t.win&&"🏆 "}{t.n}</div></div>))}
        </div>}
        {anyValid && <div style={{textAlign:"center",fontFamily:"Anton",fontSize:18,
          color:T.gold,marginBottom:12}}>{rV?.summary}</div>}
        {/* ⚡ FAITS DE JEU : événements spéciaux qui expliquent le score (mexicaine) */}
        {anyValid && rV?.events?.length>0 && <div style={{borderTop:`1px solid ${T.line}`,
          paddingTop:8,marginBottom:10}}>
          <div style={{fontSize:10,color:T.dim,marginBottom:6,textTransform:"uppercase",
            letterSpacing:.5,fontWeight:700}}>⚡ Faits de jeu</div>
          {[...rV.events].reverse().slice(0,8).map((e,i)=>(
            <div key={i} style={{fontSize:11,color:T.dim,marginBottom:3,lineHeight:1.35}}>
              <b style={{color:T.text}}>Trou {e.h}</b> — {e.notes.join(" · ")}</div>))}
        </div>}
        {/* STABLEFORD BRUT INDIVIDUEL (secondaire) */}
        {anyValid && <div style={{borderTop:`1px solid ${T.line}`,paddingTop:8}}>
          <div style={{fontSize:10,color:T.dim,marginBottom:6,textTransform:"uppercase",
            letterSpacing:.5,fontWeight:700}}>Stableford brut individuel</div>
          {indiv.map((r,i)=>(
            <div key={r.p.id} style={{display:"flex",justifyContent:"space-between",
              alignItems:"center",fontSize:12,marginBottom:4}}>
              <span style={{color:T.dim}}>
                <span style={{display:"inline-block",width:7,height:7,borderRadius:2,
                  background:r.team===0?T.eu:T.us,marginRight:6}}/>
                {dispName(r.p)}</span>
              <span style={{fontWeight:800,color:T.text}}>{r.stb} <span style={{fontSize:9,color:T.dim}}>pts</span></span>
            </div>))}
        </div>}
      </div>
    );
  }

  // ===== Affichage spécial MATCH PLAY 1v1 : STATUT en vedette + Stableford brut individuel =====
  if(f==="matchplay" && ps.length===2){
    const nameA=dispName(ps[0]),nameB=dispName(ps[1]);
    const indiv=ps.map(p=>({p,stb:stablefordBrut(sg,p,course,validated)}));
    return (
      <div style={{marginTop:12,background:`linear-gradient(180deg,${T.panel2},${T.panel})`,
        borderRadius:12,padding:12,border:`1px solid ${T.line}`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <span style={{fontFamily:"Anton",fontSize:14,letterSpacing:.5}}>🏌️ MATCH PLAY</span>
          <span style={{fontSize:10,color:T.dim}}>{validated.length} tr. validés</span></div>
        {!anyValid && <div style={{fontSize:12,color:T.dim,textAlign:"center",padding:"8px 0"}}>
          Valide des trous (bouton ✓) pour voir le statut du match…</div>}
        {/* LE STATUT MATCH PLAY = donnée principale, en GROS */}
        {anyValid && <div style={{textAlign:"center",padding:"16px 10px",borderRadius:14,
          marginBottom:10,border:`2px solid ${(rV?.winner?T.gold:T.accent)}66`,
          background:`${(rV?.winner?T.gold:T.accent)}14`}}>
          <div style={{fontFamily:"Anton",fontSize:26,lineHeight:1.05,
            color:rV?.winner?T.gold:T.accent}}>{rV?.summary}</div>
          <div style={{fontSize:11,color:T.dim,marginTop:5}}>{nameA} vs {nameB}</div></div>}
        {/* Scores individuels = secondaires, en Stableford BRUT (pas le total de coups) */}
        {anyValid && <div style={{borderTop:`1px solid ${T.line}`,paddingTop:8}}>
          <div style={{fontSize:10,color:T.dim,marginBottom:6,textTransform:"uppercase",
            letterSpacing:.5,fontWeight:700}}>Stableford brut individuel</div>
          {indiv.map(r=>(
            <div key={r.p.id} style={{display:"flex",justifyContent:"space-between",
              alignItems:"center",fontSize:12,marginBottom:4}}>
              <span style={{color:T.dim}}>{dispName(r.p)}</span>
              <span style={{fontWeight:800,color:T.text}}>{r.stb} <span style={{fontSize:9,color:T.dim}}>pts</span></span>
            </div>))}
        </div>}
      </div>
    );
  }

  // formules à POINTS par joueur : on lit les points calculés
  const pointFormulas=["chouette","onevonevone","stableford","stableford_net","stableford_gross","skins"];
  const isPoints=pointFormulas.includes(f);
  const isTeam=["matchplay","strokeplay_net"].includes(f);

  // construit les lignes selon le type de formule
  let rows=[];
  if(isPoints){
    const pmap=rV?.pts||{};
    // si pas de pts (stableford/skins renvoient un summary), on reparse depuis le résumé impossible :
    // on recalcule les points simples ici pour stableford/skins
    if(Object.keys(pmap).length){
      rows=ps.map(p=>({p,val:pmap[p.id]||0}));
    } else {
      // stableford / skins : recompute points par joueur sur trous validés
      rows=ps.map(p=>{
        const chp=effChp(p,ps,course,sg.hcpRelative);
        const useNet=f==="stableford_gross"?false:net;
        const strokes=useNet?strokesPerHole(chp,course?.si):new Array(18).fill(0);
        let pts=0;
        validated.forEach(h=>{const g=sg.scores?.[p.id]?.[h];if(g==null)return;
          const s=g-strokes[h];pts+=Math.max(0,2+(holePars(course)[h]-s));});
        return {p,val:pts};
      });
    }
    rows=rows.filter(r=>r.val!=null).sort((a,b)=>b.val-a.val); // plus de points = mieux
  } else {
    // coups nets (stroke/match) : plus petit = mieux
    rows=ps.map(p=>{
      const chp=effChp(p,ps,course,sg.hcpRelative);
      const strokes=net?strokesPerHole(chp,course?.si):new Array(18).fill(0);
      let netTot=0,played=0;
      validated.forEach(h=>{const s=sg.scores?.[p.id]?.[h];if(s==null)return;played++;netTot+=s-strokes[h];});
      return {p,val:netTot,played};
    }).filter(r=>r.played>0).sort((a,b)=>a.val-b.val);
  }
  const anyScore=validated.length>0 && rows.length>0;
  const vals=rows.map(r=>r.val);
  const best=vals.length?(isPoints?Math.max(...vals):Math.min(...vals)):0;
  const worst=vals.length?(isPoints?Math.min(...vals):Math.max(...vals)):1;
  const span=Math.max(1,Math.abs(worst-best));
  const unit=isPoints?"pts":(net?"net":"brut");

  return (
    <div style={{marginTop:12,background:`linear-gradient(180deg,${T.panel2},${T.panel})`,
      borderRadius:12,padding:12,border:`1px solid ${T.line}`}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
        marginBottom:10}}>
        <span style={{fontFamily:"Anton",fontSize:14,letterSpacing:.5}}>📊 RÉSULTATS LIVE</span>
        <span style={{fontSize:10,color:T.dim}}>{unit.toUpperCase()} · {validated.length} tr. validés</span></div>
      {!anyScore && <div style={{fontSize:12,color:T.dim,textAlign:"center",padding:"8px 0"}}>
        Valide des trous (bouton ✓) pour voir le classement s'animer…</div>}
      {rows.map((r,i)=>{
        const pct=isPoints
          ? 30+((r.val-worst)/span)*70
          : 100-((r.val-best)/span)*70;
        const isLeader=i===0;
        return (
          <div key={r.p.id} style={{marginBottom:8}}>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:12,
              marginBottom:3}}>
              <span style={{fontWeight:800,color:isLeader?T.gold:T.text}}>
                {i+1}. {dispName(r.p)} {isLeader&&"👑"}</span>
              <span style={{fontFamily:"Anton",fontSize:16,
                color:isLeader?T.gold:T.accent}}>{r.val}{isPoints?<span style={{fontSize:9,color:T.dim}}> pts</span>:""}</span></div>
            <div style={{height:8,borderRadius:999,background:T.bg,overflow:"hidden"}}>
              <div style={{width:`${Math.max(12,pct)}%`,height:"100%",borderRadius:999,
                background:isLeader?`linear-gradient(90deg,${T.gold},#b8860b)`:
                `linear-gradient(90deg,${T.accent},${T.eu})`,transition:"width .5s ease"}}/>
            </div>
          </div>
        );
      })}
      {rV&&anyScore&&(f==="matchplay"||f==="matchplay2v2")&&
        <div style={{marginTop:10,padding:"10px",borderRadius:10,background:T.bg,textAlign:"center",
          fontWeight:800,fontSize:16,color:T.gold,border:`1px solid ${T.gold}55`}}>
          🏌️ {rV.summary}</div>}
      {(isTeam&&rV&&f!=="matchplay2v2")&&<div style={{marginTop:4,fontSize:13,fontWeight:700,
        textAlign:"center",color:T.gold}}>{rV.summary}</div>}
      {rV&&anyScore&&!isTeam&&f!=="matchplay"&&<div style={{marginTop:8,fontSize:12,color:T.dim,
        borderTop:`1px solid ${T.line}`,paddingTop:8}}>
        ⚡ {rV.summary}</div>}
    </div>
  );
}

/* ===== Tirage chapeaux (Ryder Cup) : propositions classées par équilibre + valider/refaire ===== */
function DrawHats({g,onAssign}){
  const [spinning,setSpinning]=useState(false);
  const [configs,setConfigs]=useState(null); // configs classées (plus équilibrée d'abord)
  const [idx,setIdx]=useState(0);
  const draw=()=>{
    setSpinning(true);setConfigs(null);
    setTimeout(()=>{ setConfigs(drawTeamConfigs(g.roster)); setIdx(0); setSpinning(false); },1100);
  };
  const [n0,n1]=g.teamNames||["Équipe 1","Équipe 2"];
  const nh=Math.ceil(g.roster.length/2);
  const cur=configs?configs[idx]:null;
  const e0=cur?g.roster.filter(p=>cur.assign[p.id]===0):[];
  const e1=cur?g.roster.filter(p=>cur.assign[p.id]===1):[];
  const validate=()=>cur&&onAssign({assign:cur.assign,hats:cur.hats});
  const another=()=>setIdx(i=>(i+1)%configs.length);
  return (
    <div style={{...card(T.us),marginBottom:14}}>
      <div style={{fontWeight:800,marginBottom:4}}>🎩 Tirage des équipes (par index)</div>
      <div style={{fontSize:11,color:T.dim,marginBottom:8}}>
        Joueurs triés par index → {nh} chapeaux de 2 → 1 par chapeau dans chaque équipe, avec les
        <b> totaux d'index les plus serrés</b>. Tu valides, ou tu demandes la proposition suivante
        (la 2e plus équilibrée, puis la 3e…).</div>
      {!configs&&<button onClick={draw} disabled={spinning} style={{...addBtn,marginTop:0,
        background:spinning?T.line:`linear-gradient(90deg,${T.eu},${T.us})`,color:"#fff",
        fontFamily:"'Archivo',sans-serif",letterSpacing:.5,fontSize:16}}>
        {spinning?<span><span style={{display:"inline-block",animation:"spin .7s linear infinite"}}>🎩</span> Tirage…</span>
          :"🎩 LANCER LE TIRAGE"}</button>}
      {cur&&<div>
        <div style={{display:"flex",gap:10,marginTop:4}}>
          <div style={{flex:1,background:T.eu,borderRadius:10,padding:10}}>
            <div style={{fontFamily:"Anton",fontSize:15}}>{n0} <span style={{fontSize:11,opacity:.8}}>· Σ{cur.tot[0]}</span></div>
            {e0.map(p=><div key={p.id} style={{fontSize:12,marginTop:2}}>{dispName(p)} <span style={{opacity:.7}}>({p.index})</span></div>)}</div>
          <div style={{flex:1,background:T.us,borderRadius:10,padding:10}}>
            <div style={{fontFamily:"Anton",fontSize:15}}>{n1} <span style={{fontSize:11,opacity:.8}}>· Σ{cur.tot[1]}</span></div>
            {e1.map(p=><div key={p.id} style={{fontSize:12,marginTop:2}}>{dispName(p)} <span style={{opacity:.7}}>({p.index})</span></div>)}</div>
        </div>
        <div style={{fontSize:11,color:T.dim,marginTop:8,textAlign:"center"}}>
          Proposition {idx+1}/{configs.length} · écart d'index <b style={{color:cur.diff<=2?T.accent:T.gold}}>{cur.diff}</b>
          {idx===0?" (la plus équilibrée)":""}</div>
        <div style={{display:"flex",gap:8,marginTop:10}}>
          <button onClick={validate} style={{...addBtn,flex:1,margin:0,background:T.accent,color:"#04150b"}}>✅ Valider ces équipes</button>
          {configs.length>1&&<button onClick={another} style={{...delBtn,flex:1,borderColor:T.gold,color:T.gold}}>🔄 Autre proposition</button>}
        </div>
        <div style={{fontSize:10,color:T.dim,marginTop:6,textAlign:"center"}}>
          Tant que tu ne valides pas, les équipes ne sont pas appliquées.</div>
      </div>}
    </div>
  );
}

// Scoreboard Ryder façon EUR–USA : totaux par équipe + statut de chaque match, manche par
// manche. 1 pt par match gagné, ½ par match nul. Visible en cours (progression jour par jour).
// Visuel du bracket (Coupe) : tours, matchs avec vainqueur, et le champion.
function BracketBoard({g,courses,playerById}){
  const net=g.mode==="net";
  const champ=coupeChampion(g,courses);
  return (
    <div style={{marginBottom:12}}>
      {champ&&<div style={{...card(T.gold),textAlign:"center",marginBottom:10}}>
        <div style={{fontSize:11,color:T.dim,letterSpacing:1}}>🏆 CHAMPION</div>
        <div style={{fontFamily:"Anton",fontSize:26,color:T.gold}}>{dispName(playerById(champ))}</div></div>}
      {(g.rounds||[]).map(r=>{const course=courses.find(c=>c.id===r.courseId);
        return (
        <div key={r.id} style={{marginBottom:6}}>
          <div style={{fontSize:10,fontWeight:800,letterSpacing:.5,color:T.gold,
            textTransform:"uppercase",margin:"8px 2px 4px"}}>{r.name}</div>
          {r.subgames.map(sg=>{const ps=sg.players.map(playerById).filter(Boolean);
            const bye=(sg.players||[]).length===1;
            const winner=(sg.done||bye)?matchWinnerId(sg,g.roster||[],course,net):null;
            return (
            <div key={sg.id} style={{...card(T.line),padding:"7px 10px",marginBottom:5}}>
              {ps.map(p=>{const win=String(winner)===String(p.id);return (
                <div key={p.id} style={{display:"flex",justifyContent:"space-between",fontSize:13,
                  fontWeight:win?800:600,color:win?T.accent:T.text}}>
                  <span>{dispName(p)}</span>{win&&<span>✓</span>}</div>);})}
              <div style={{fontSize:10,color:T.dim,marginTop:2}}>
                {bye?"bye · qualifié":sg.done?FORMULA_SHORT[sg.formula]:`à jouer · ${FORMULA_SHORT[sg.formula]}`}</div>
            </div>);})}
        </div>);})}
    </div>
  );
}

function RyderBoard({g,courses,playerById}){
  const net=g.mode==="net";
  const [n0,n1]=g.teamNames||["Équipe 1","Équipe 2"];
  if(!(g.roster||[]).some(p=>p.team===0||p.team===1)) return null; // pas encore d'équipes
  const fmt=v=>v%1>0?(Math.floor(v)?`${Math.floor(v)}½`:"½"):String(v);
  const rounds=(g.rounds||[]).map(r=>{
    const course=courses.find(c=>c.id===r.courseId);
    const matches=r.subgames.map(sg=>{
      const ps=sg.players.map(playerById).filter(Boolean);
      const res=computeSub(sg,ps,course,net)||{};
      const {pts}=playerScores(sg,ps,course,net);
      const a=ps.filter(p=>p.team===0),b=ps.filter(p=>p.team===1);
      const pa=a.reduce((s,p)=>s+(pts[p.id]||0),0),pb=b.reduce((s,p)=>s+(pts[p.id]||0),0);
      const played=(sg.validated||[]).length>0;
      const winner=!played?null:pa>pb?0:pb>pa?1:-1; // -1 = nul (½ partout)
      return {sg,a,b,res,played,winner};
    });
    return {r,course,matches};
  });
  let s0=0,s1=0,Tot=0;
  rounds.forEach(rd=>rd.matches.forEach(m=>{Tot++;if(m.played){
    if(m.winner===0)s0++;else if(m.winner===1)s1++;else if(m.winner===-1){s0+=.5;s1+=.5;}}}));
  const toWin=Tot%2===0?Tot/2+0.5:Math.ceil(Tot/2);
  const lead=s0>s1?0:s1>s0?1:-1;
  return (
    <div style={{marginTop:14}}>
      <div style={{display:"flex",borderRadius:14,overflow:"hidden",border:`1px solid ${T.line}`}}>
        <div style={{flex:1,background:`linear-gradient(135deg,${T.eu},${T.eu}bb)`,padding:"12px 14px",color:"#fff"}}>
          <div style={{fontSize:12,fontWeight:800,opacity:.95}}>{n0}</div>
          <div style={{fontFamily:"Anton",fontSize:34,lineHeight:1}}>{fmt(s0)}</div></div>
        <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
          padding:"0 10px",background:T.panel,fontSize:10,color:T.dim,textAlign:"center",lineHeight:1.2}}>
          <span style={{fontFamily:"Anton",fontSize:16,color:T.gold}}>{fmt(toWin)}</span>pour gagner</div>
        <div style={{flex:1,background:`linear-gradient(225deg,${T.us},${T.us}bb)`,padding:"12px 14px",color:"#fff",textAlign:"right"}}>
          <div style={{fontSize:12,fontWeight:800,opacity:.95}}>{n1}</div>
          <div style={{fontFamily:"Anton",fontSize:34,lineHeight:1}}>{fmt(s1)}</div></div>
      </div>
      <div style={{textAlign:"center",fontSize:12,fontWeight:800,color:T.accent,margin:"8px 0 2px"}}>
        {lead===-1?"🤝 Tout est serré !":`🏆 ${lead===0?n0:n1} mène`}</div>
      {rounds.map((rd,ri)=>(
        <div key={ri} style={{marginTop:8}}>
          <div style={{fontSize:10,fontWeight:800,letterSpacing:.5,color:T.dim,
            textTransform:"uppercase",margin:"8px 2px 4px"}}>Manche {rd.r.id} · {rd.course?.name}</div>
          {rd.matches.map((m,mi)=>{const col=t=>m.winner===t?(t===0?T.eu:T.us):T.text;
            return (
            <div key={mi} style={{...card(T.line),padding:"8px 10px",marginBottom:6}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:6,fontSize:12}}>
                <span style={{flex:1,fontWeight:m.winner===0?800:600,color:col(0)}}>
                  {m.a.map(dispName).join(" / ")||"—"}</span>
                <span style={{fontSize:9,color:T.dim,padding:"2px 6px",background:T.bg,
                  borderRadius:6,whiteSpace:"nowrap"}}>{FORMULA_SHORT[m.sg.formula]||""}</span>
                <span style={{flex:1,textAlign:"right",fontWeight:m.winner===1?800:600,color:col(1)}}>
                  {m.b.map(dispName).join(" / ")||"—"}</span>
              </div>
              <div style={{fontSize:11,color:m.played?T.dim:T.dim,marginTop:3,textAlign:"center"}}>
                {m.played?m.res.summary:"⏳ à jouer"}</div>
            </div>);})}
        </div>
      ))}
    </div>
  );
}

function EventBoard({g,courses,playerById}){
  const net=g.mode==="net";let t0=0,t1=0;
  const allSubs=g.rounds
    ? g.rounds.flatMap(r=>r.subgames.map(sg=>({sg,course:courses.find(c=>c.id===r.courseId)})))
    : g.subgames.map(sg=>({sg,course:courses.find(c=>c.id===g.courseId)}));
  allSubs.forEach(({sg,course})=>{
    const ps=sg.players.map(playerById).filter(Boolean);
    const {pts}=playerScores(sg,ps,course,net);
    // chaque joueur apporte ses points (2/1/0) à son équipe
    Object.entries(pts).forEach(([id,pt])=>{
      const p=g.roster.find(x=>String(x.id)===String(id));
      if(p?.team===0)t0+=pt;else if(p?.team===1)t1+=pt;});
  });
  const [n0,n1]=g.teamNames||["Équipe 1","Équipe 2"];
  const lead=t0>t1?n0:t1>t0?n1:"Égalité";
  return (
    <div style={{...card(T.gold),marginTop:14,textAlign:"center"}}>
      <div style={{fontFamily:"Anton",fontSize:16,marginBottom:4}}>CLASSEMENT TOURNOI</div>
      <div style={{fontSize:11,color:T.dim,marginBottom:8}}>
        Cumul sur {g.rounds?`${g.rounds.length} manche(s)`:"la partie"} · points 2/1/0</div>
      <div style={{display:"flex",justifyContent:"space-around",fontWeight:800}}>
        <div><div style={{color:"#6db1ff"}}>{n0}</div>
          <div style={{fontFamily:"Anton",fontSize:32,color:t0>=t1?T.gold:T.text}}>{t0}</div></div>
        <div><div style={{color:"#ff8a8a"}}>{n1}</div>
          <div style={{fontFamily:"Anton",fontSize:32,color:t1>=t0?T.gold:T.text}}>{t1}</div></div>
      </div>
      <div style={{marginTop:8,fontSize:13,fontWeight:800,color:T.accent}}>
        {lead==="Égalité"?"Égalité parfaite !":`🏆 ${lead} mène`}</div>
    </div>
  );
}

function computeSub(sg,ps,course,net){
  if(!course||!ps.length) return null;
  const holes=(useNet)=>p=>{
    const chp=effChp(p,ps,course,sg.hcpRelative);
    const strokes=strokesPerHole(chp,course.si);
    return Array.from({length:18},(_,i)=>{const g=sg.scores?.[p.id]?.[i];
      if(g==null) return null;return useNet?g-strokes[i]:g;});};
  const f=sg.formula;
  // Stableford a ses propres variantes brut/net indépendantes du mode partie
  const useNet = f==="stableford_net" ? true : f==="stableford_gross" ? false : net;
  const holeNet=holes(useNet);
  const nets={};ps.forEach(p=>nets[p.id]=holeNet(p));
  if(f==="onevonevone"){
    const pts={};ps.forEach(p=>pts[p.id]=0);
    for(let h=0;h<18;h++){const vals=ps.map(p=>({id:p.id,s:nets[p.id][h]})).filter(x=>x.s!=null);
      if(vals.length<ps.length) continue;
      const min=Math.min(...vals.map(v=>v.s));
      const w=vals.filter(v=>v.s===min);w.forEach(v=>pts[v.id]+=1/w.length);}
    const rank=ps.map(p=>({name:dispName(p),pts:Math.round(pts[p.id]*10)/10})).sort((x,y)=>y.pts-x.pts);
    return {pts,summary:rank.map(r=>`${r.name} ${r.pts}`).join(" · "),winner:rank[0]?.name};
  }
  if(f==="chouette"){
    // 6 pts/trou. UN seul net par joueur (= brut - coups rendus ; relatifs au plus bas
    // joueur si la case "match play" est cochée). Classement des 3 nets :
    //   3 distincts → 4/2/0 · 3 égaux → 2/2/2 · égalité 1re → 3/3/0 · égalité 2e → 4/1/1.
    // On COMPTE et SIGNALE les LITIGES = trous à égalité (points partagés). Comme demandé,
    // on garde une seule partie à 3 : un joueur peut être desservi (duel J2↔J3), mais c'est
    // notifié à chaque trou litigieux.
    const pts={};ps.forEach(p=>pts[p.id]=0); let litiges=0;
    for(let h=0;h<18;h++){
      const trio=ps.map(p=>({id:p.id,s:nets[p.id][h]}));
      if(trio.some(x=>x.s==null)) continue;
      const sorted=[...trio].sort((a,b)=>a.s-b.s);
      const [a,b,c]=sorted; // a meilleur net (plus petit), c le pire
      if(a.s<b.s && b.s<c.s){            // 3 nets distincts → pas de litige
        pts[a.id]+=4; pts[b.id]+=2; pts[c.id]+=0;
      } else if(a.s===b.s && b.s===c.s){ // les 3 égaux
        pts[a.id]+=2; pts[b.id]+=2; pts[c.id]+=2; litiges++;
      } else if(a.s===b.s && b.s<c.s){   // égalité en tête
        pts[a.id]+=3; pts[b.id]+=3; pts[c.id]+=0; litiges++;
      } else if(a.s<b.s && b.s===c.s){   // gagnant seul + égalité 2e/3e
        pts[a.id]+=4; pts[b.id]+=1; pts[c.id]+=1; litiges++;
      }
    }
    const rank=ps.map(p=>({name:dispName(p),pts:pts[p.id]})).sort((x,y)=>y.pts-x.pts);
    return {pts,summary:rank.map(r=>`${r.name} ${r.pts}`).join(" · "),
      winner:rank[0]?.name,litiges};
  }
  // Match play (et tous les fourball-like : on compare la MEILLEURE balle nette de chaque
  // équipe par trou → statut 1 UP / All Square / 2&1).
  if(f==="matchplay"||f==="matchplay2v2"||f==="fourball"||f==="foursome"||f==="scramble"||f==="chamble"){
    const a=f==="matchplay"?[ps[0]]:ps.slice(0,2);
    const b=f==="matchplay"?[ps[1]]:ps.slice(2,4);
    const th_=(team,h)=>{const v=team.map(p=>nets[p.id][h]).filter(x=>x!=null);
      return v.length?Math.min(...v):null;};
    let win=0,played=0;                 // win>0 = A mène ; played = trous joués
    for(let h=0;h<18;h++){const e=th_(a,h),u=th_(b,h);
      if(e==null||u==null)continue; played++; if(e<u)win++;else if(u<e)win--;}
    const A=a.map(p=>dispName(p)).join("/"),B=b.map(p=>dispName(p)).join("/");
    const lead=Math.abs(win), leader=win>0?A:B, remaining=18-played;
    let summary,winner=null;
    if(win!==0 && lead>remaining){       // match plié (avance > trous restants)
      winner=leader;
      summary = remaining>0 ? `${leader} gagne ${lead}&${remaining}`
                            : `${leader} gagne ${lead} UP`;
    } else if(played>=18){               // arrivé au 18e
      if(win===0) summary="Match nul — All Square (½)";
      else { winner=leader; summary=`${leader} gagne ${lead} UP`; }
    } else if(win===0){                  // en cours, à égalité
      summary = played===0 ? "All Square (départ)" : "All Square (à égalité)";
    } else {                             // en cours, un joueur mène
      summary = `${leader} ${lead} UP`+(lead===remaining?" · dormie 🔥":"");
    }
    return {summary,winner,mpWin:win,mpPlayed:played};
  }
  if(f==="mexicaine"){
    // 2v2 BRUT. Par trou : nombre à 2 chiffres (meilleur en 1er). Croix = par+4.
    // Inversion du nombre de l'équipe SANS birdie si l'autre a ≥1 birdie (sinon annulé).
    // Puis bonus : par+par +5, birdie+birdie +10. Plus petit nombre gagne, écart = diff.
    const a=ps.slice(0,2),b=ps.slice(2,4);
    const pars=holePars(course);
    const NA=a.map(p=>dispName(p)).join("/"),NB=b.map(p=>dispName(p)).join("/");
    const teamNum=(team,h,oppHasBirdie,parH)=>{
      // scores bruts des 2 joueurs, croix = par+4
      const raw=team.map(p=>{const g=sg.scores?.[p.id]?.[h];return g==null?null:g;});
      if(raw.some(x=>x==null)) return null;
      const sc=raw.map(g=>g); // déjà bruts
      const birdies=sc.filter(s=>s<parH).length;
      const lo=Math.min(...sc),hi=Math.max(...sc);
      let num=lo*10+hi;                 // meilleur en premier
      let inverted=false,parPar=false,dd=false;
      // inversion : cette équipe n'a aucun birdie ET l'adversaire en a
      if(birdies===0 && oppHasBirdie){ num=hi*10+lo; inverted=true; }
      // bonus (après inversion)
      if(sc[0]===parH&&sc[1]===parH){ num+=5; parPar=true; }    // par + par
      if(sc.every(s=>s<parH)){ num+=10; dd=true; }              // birdie + birdie
      return {num,birdies,inverted,parPar,dd};
    };
    let cumA=0,cumB=0; const events=[];
    for(let h=0;h<18;h++){const parH=pars[h];
      // 1er passage : connaître les birdies de chaque équipe (avant inversion)
      const birds=(team)=>{const r=team.map(p=>sg.scores?.[p.id]?.[h]);
        if(r.some(x=>x==null))return null;return r.filter(s=>s<parH).length;};
      const ba=birds(a),bb=birds(b);
      if(ba==null||bb==null) continue;
      const na=teamNum(a,h,bb>0,parH),nb=teamNum(b,h,ba>0,parH);
      if(!na||!nb) continue;
      if(na.num<nb.num) cumA+=nb.num-na.num;
      else if(nb.num<na.num) cumB+=na.num-nb.num;
      // ÉVÉNEMENTS SPÉCIAUX du trou (pour expliquer le score)
      const ev=[];
      if(na.inverted) ev.push(`🔄 ${NA} : score inversé (birdie adverse)`);
      if(nb.inverted) ev.push(`🔄 ${NB} : score inversé (birdie adverse)`);
      if(na.dd) ev.push(`🐦🐦 ${NA} : 2 birdies (+10)`); else if(na.parPar) ev.push(`🎯 ${NA} : par+par (+5)`);
      if(nb.dd) ev.push(`🐦🐦 ${NB} : 2 birdies (+10)`); else if(nb.parPar) ev.push(`🎯 ${NB} : par+par (+5)`);
      if(ev.length) events.push({h:h+1,notes:ev});
    }
    const A=NA,B=NB;
    const lead=cumA>cumB?`${A} mène ${cumA}–${cumB} pts`:cumB>cumA?`${B} mène ${cumB}–${cumA} pts`:`Égalité ${cumA}–${cumB} pts`;
    return {summary:lead,winner:cumA>cumB?A:cumB>cumA?B:null,mexA:cumA,mexB:cumB,events};
  }
  if(f==="bestworst"){
    // « Meilleure & moins bonne » 2v2 : 2 pts/trou. 1 pt à l'équipe dont la MEILLEURE
    // balle (net le + bas) gagne, 1 pt à l'équipe dont la MOINS BONNE balle (le + bas des
    // deux scores hauts) gagne. Égalité = ½–½. On cumule sur 18 ; le plus gros total gagne.
    const a=ps.slice(0,2),b=ps.slice(2,4);
    let cumA=0,cumB=0;
    for(let h=0;h<18;h++){
      const an=a.map(p=>nets[p.id][h]).filter(x=>x!=null);
      const bn=b.map(p=>nets[p.id][h]).filter(x=>x!=null);
      if(an.length<2||bn.length<2) continue; // il faut les 2 scores de chaque équipe
      const bestA=Math.min(...an),worstA=Math.max(...an);
      const bestB=Math.min(...bn),worstB=Math.max(...bn);
      if(bestA<bestB) cumA++; else if(bestB<bestA) cumB++; else {cumA+=.5;cumB+=.5;}   // meilleure balle
      if(worstA<worstB) cumA++; else if(worstB<worstA) cumB++; else {cumA+=.5;cumB+=.5;} // moins bonne balle
    }
    const A=a.map(p=>dispName(p)).join("/"),B=b.map(p=>dispName(p)).join("/");
    const lead=cumA>cumB?`${A} mène ${cumA}–${cumB} pts`:cumB>cumA?`${B} mène ${cumB}–${cumA} pts`:`Égalité ${cumA}–${cumB} pts`;
    return {summary:lead,winner:cumA>cumB?A:cumB>cumA?B:null,teamA:cumA,teamB:cumB};
  }
  if(f==="stableford"||f==="stableford_net"||f==="stableford_gross"){
    const par=course.par||72;const stbl={};
    ps.forEach(p=>{let pts=0;for(let h=0;h<18;h++){const s=nets[p.id][h];if(s==null)continue;
      const parH=Math.round(par/18);pts+=Math.max(0,2+(parH-s));}stbl[p.id]=pts;});
    const rank=ps.map(p=>({name:dispName(p),pts:stbl[p.id],
      bd:countNetBirdies(nets[p.id],course)}))
      .sort((a,b)=>b.pts-a.pts||b.bd-a.bd);
    const tag=f==="stableford_gross"?" (brut)":f==="stableford_net"?" (net)":"";
    return {summary:rank.map(r=>`${r.name} ${r.pts}pts`).join(" · ")+tag,winner:rank[0]?.name};
  }
  if(f==="skins"){
    // 18 points en jeu (1 par trou). Trou nul → le point se REPORTE sur le(s) suivant(s).
    const sk={};ps.forEach(p=>sk[p.id]=0);let carry=0;
    for(let h=0;h<18;h++){const vals=ps.map(p=>({id:p.id,s:nets[p.id][h]})).filter(x=>x.s!=null);
      if(!vals.length){carry++;continue;}
      const min=Math.min(...vals.map(v=>v.s));
      const w=vals.filter(v=>v.s===min);
      if(w.length===1){sk[w[0].id]+=1+carry;carry=0;}else carry++;}
    const rank=ps.map(p=>({name:dispName(p),s:sk[p.id],
      bd:countNetBirdies(nets[p.id],course)})).sort((a,b)=>b.s-a.s||b.bd-a.bd);
    const enJeu=Object.values(sk).reduce((a,b)=>a+b,0);
    const note=carry>0?` · ${carry} pt(s) non attribué(s) (dernier trou nul)`:"";
    return {summary:rank.map(r=>`${r.name} ${r.s}`).join(" · ")+` skins (${enJeu}/18)`+note,
      winner:rank[0]?.s>0?rank[0]?.name:null};
  }
  const rank=ps.map(p=>({name:dispName(p),tot:nets[p.id].reduce((a,b)=>a+(b||0),0),
    bd:countNetBirdies(nets[p.id],course)}))
    .sort((a,b)=>a.tot-b.tot||b.bd-a.bd);
  return {summary:rank.map(r=>`${r.name} ${r.tot}`).join(" · "),winner:rank[0]?.name};
}

/* ===== Points championnat (2 victoire / 1 nul / 0 défaite) par joueur d'une sous-partie
   + confrontations individuelles (head-to-head) ===== */
function playerScores(sg,ps,course,net){
  if(!course||!ps.length||ps.length<2) return {pts:{},h2h:[]};
  const useNet = sg.formula==="stableford_net"?true:sg.formula==="stableford_gross"?false:net;
  const holeNet=p=>{
    const chp=effChp(p,ps,course,sg.hcpRelative);
    const strokes=strokesPerHole(chp,course.si);
    return Array.from({length:18},(_,i)=>{const g=sg.scores?.[p.id]?.[i];
      if(g==null) return null;return useNet?g-strokes[i]:g;});};
  const nets={};ps.forEach(p=>nets[p.id]=holeNet(p));
  const total=p=>nets[p.id].reduce((a,b)=>a+(b||0),0);
  const played=p=>nets[p.id].some(v=>v!=null);
  if(!ps.some(played)) return {pts:{},h2h:[]}; // pas encore de scores

  const f=sg.formula;
  const pts={};const h2h=[];

  // Mexicaine : résultat collectif via le calcul dédié (cumul des écarts)
  if(f==="mexicaine"){
    const a=ps.slice(0,2),b=ps.slice(2,4);
    const r=computeSub(sg,ps,course,net)||{};
    const cumA=r.mexA||0,cumB=r.mexB||0;
    const av=cumA>cumB?3:cumA<cumB?0:1, bv=cumB>cumA?3:cumB<cumA?0:1;
    const ra=cumA>cumB?'W':cumA<cumB?'L':'D', rb=cumB>cumA?'W':cumB<cumA?'L':'D';
    const res={};a.forEach(p=>{pts[p.id]=av;res[p.id]=ra;}); b.forEach(p=>{pts[p.id]=bv;res[p.id]=rb;});
    return {pts,h2h,res};
  }
  if(f==="bestworst"){
    const a=ps.slice(0,2),b=ps.slice(2,4);
    const r=computeSub(sg,ps,course,net)||{};
    const cumA=r.teamA||0,cumB=r.teamB||0;
    const av=cumA>cumB?3:cumA<cumB?0:1, bv=cumB>cumA?3:cumB<cumA?0:1;
    const ra=cumA>cumB?'W':cumA<cumB?'L':'D', rb=cumB>cumA?'W':cumB<cumA?'L':'D';
    const res={};a.forEach(p=>{pts[p.id]=av;res[p.id]=ra;}); b.forEach(p=>{pts[p.id]=bv;res[p.id]=rb;});
    return {pts,h2h,res};
  }
  // Formats équipe : 2 vs 2 → victoire collective (3/1/0) par membre
  if(f==="fourball"||f==="foursome"||f==="scramble"||f==="chamble"||f==="matchplay2v2"){
    const a=ps.slice(0,2),b=ps.slice(2,4);
    const th=(team,h)=>{const v=team.map(p=>nets[p.id][h]).filter(x=>x!=null);
      return v.length?Math.min(...v):null;};
    let w=0;for(let h=0;h<18;h++){const e=th(a,h),u=th(b,h);
      if(e==null||u==null)continue;if(e<u)w++;else if(u<e)w--;}
    const av=w>0?3:w<0?0:1, bv=w<0?3:w>0?0:1;
    const ra=w>0?'W':w<0?'L':'D', rb=w<0?'W':w>0?'L':'D';
    const res={};a.forEach(p=>{pts[p.id]=av;res[p.id]=ra;}); b.forEach(p=>{pts[p.id]=bv;res[p.id]=rb;});
    return {pts,h2h,res};
  }
  // Tous les autres (1v1, chouette, 1v1v1, stableford, skins, stroke) :
  // classement par total net croissant ; départage à égalité = birdies nets (plus = mieux).
  const bd=p=>countNetBirdies(nets[p.id],course);
  const cmp=(x,y)=>total(x)-total(y)||bd(y)-bd(x); // total asc, puis birdies desc
  const ranked=[...ps].filter(played).sort(cmp);
  if(!ranked.length) return {pts:{},h2h:[]};
  // gagnant(s) : total ET birdies identiques au meilleur = égalité parfaite
  const top=ranked[0];
  const winners=ranked.filter(p=>total(p)===total(top)&&bd(p)===bd(top));
  // confrontations individuelles (chaque paire), départage birdies nets
  for(let i=0;i<ranked.length;i++)for(let j=i+1;j<ranked.length;j++){
    const A=ranked[i],B=ranked[j],ta=total(A),tb=total(B),ba=bd(A),bb=bd(B);
    let dr;
    if(ta<tb) dr="a"; else if(tb<ta) dr="b";
    else if(ba>bb) dr="a"; else if(bb>ba) dr="b"; else dr="nul";
    h2h.push({a:A.id,b:B.id,res:dr});
  }
  // POINTS DE MATCH = somme des DUELS. Victoire = 3 en 1v1, 2 à 3 joueurs
  // (pour que battre 2 rapporte +1, pas le double). Nul 1, défaite 0.
  const Wv = ps.length<=2 ? 3 : ps.length===3 ? 2 : 1;
  ps.forEach(p=>pts[p.id]=0);
  h2h.forEach(d=>{ if(d.res==="nul"){pts[d.a]+=1;pts[d.b]+=1;}
    else if(d.res==="a")pts[d.a]+=Wv; else pts[d.b]+=Wv; });
  // bilan victoire/nul/défaite DU MATCH (pour la colonne V-N-D)
  const res={}; ps.forEach(p=>res[p.id]='L');
  if(winners.length===1) res[winners[0].id]='W';
  else winners.forEach(p=>res[p.id]='D');
  return {pts,h2h,res};
}

const SEED_MEMBERS=[
  {id:"seed-1",name:"Philippe",nick:"",member:true,profileDone:false},
  {id:"seed-2",name:"Romain",nick:"",member:true,profileDone:false},
  {id:"seed-3",name:"Richard",nick:"",member:true,profileDone:false},
  {id:"seed-4",name:"Jean-Paul",nick:"",member:true,profileDone:false},
  {id:"seed-5",name:"Jean-Pierre",nick:"",member:true,profileDone:false},
  {id:"seed-6",name:"Thomas",nick:"",member:true,profileDone:false},
  {id:"seed-7",name:"Nico",nick:"",member:true,profileDone:false},
  {id:"seed-8",name:"Thomas F.",nick:"",member:true,profileDone:false},
  {id:"seed-9",name:"Mitch",nick:"",member:true,profileDone:false},
];
// PARCOURS RÉELS (départ jaune) sanctuarisés dans le code : par+HCP+longueur par trou,
// + longueur totale. Filet de secours si le cloud est indisponible.
const SEED_COURSES=[
  {id:1,name:"Golf Platja de Pals",country:"Espagne",par:73,
    si:[16,8,14,4,6,18,2,10,12,5,17,1,13,7,15,9,3,11],
    pars:[4,4,4,4,5,3,4,5,3,4,3,4,4,5,3,5,4,5],
    lengths:[291,305,300,359,465,151,357,458,140,320,124,387,350,498,175,492,361,447],length:5980,
    tees:[{name:"Jaune",cr:72.0,slope:133,par:73,length:5980}]},
  {id:2,name:"Empordà — Forest",country:"Espagne",par:72,
    si:[7,15,5,9,17,11,1,13,3,8,14,18,4,16,12,6,10,2],
    pars:[4,3,4,5,3,4,5,3,5,5,4,3,5,3,4,4,4,4],
    lengths:[359,159,363,481,146,281,518,164,465,469,295,151,465,143,319,351,353,384],length:5866,
    tees:[{name:"Jaune",cr:72.1,slope:126,par:72,length:5866}]},
  {id:3,name:"Empordà — Links",country:"Espagne",par:71,
    si:[9,5,17,13,7,15,11,1,3,16,14,8,10,4,18,6,2,12],
    pars:[4,4,3,4,4,3,4,5,4,4,3,5,4,4,3,4,4,5],
    lengths:[351,345,143,323,354,159,361,531,348,319,146,483,358,367,141,364,390,484],length:5967,
    tees:[{name:"Jaune",cr:72.1,slope:135,par:71,length:5967}]},
  {id:9,name:"Torremirona Golf Club",country:"Espagne",par:72,
    si:[18,14,2,12,6,8,10,4,16,17,9,15,13,5,7,1,3,11],
    pars:[4,3,4,5,3,5,4,4,4,3,4,4,5,4,3,4,4,5],
    lengths:[280,178,384,443,170,482,353,350,331,129,347,295,451,360,172,387,367,464],length:5943,
    tees:[{name:"Jaune",cr:71.7,slope:132,par:72,length:5943}]},
  {id:13,name:"Golf de Marseille La Salette",country:"France",par:72,
    si:[11,12,17,14,6,8,3,9,5,13,4,18,2,15,16,1,10,7],
    pars:[4,4,5,5,3,4,4,3,5,5,4,3,5,3,3,4,5,3],
    lengths:[271,202,433,422,132,283,352,152,406,405,286,149,447,131,135,370,359,154],length:5089,
    tees:[{name:"Jaune",cr:69.0,slope:135,par:72,length:5089}]},
  {id:14,name:"Golf de Barbaroux",country:"France",par:72,
    si:[7,9,11,17,1,3,13,15,5,12,16,4,8,14,18,6,2,10],
    pars:[4,4,5,3,5,4,4,3,4,4,4,5,4,4,3,4,5,3],
    lengths:[311,308,411,131,464,343,249,150,358,294,278,472,341,258,134,347,486,181],length:5516,
    tees:[{name:"Jaune",cr:71.4,slope:138,par:72,length:5516}]},
  {id:15,name:"Golf International Pont Royal",country:"France",par:72,
    si:[7,13,3,9,11,15,5,1,17,12,4,8,10,18,2,16,6,14],
    pars:[4,3,4,5,3,4,4,4,5,4,3,4,3,5,4,4,4,5],
    lengths:[299,130,332,474,142,288,359,367,446,331,180,336,150,444,341,339,329,455],length:5742,
    tees:[{name:"Jaune",cr:71.7,slope:144,par:72,length:5742}]},
  {id:16,name:"Sainte Victoire Golf Club (Château l'Arc)",country:"France",par:70,
    si:[15,10,16,5,4,18,13,17,6,14,8,2,1,11,7,9,3,12],
    pars:[5,4,3,4,4,4,4,3,4,3,4,4,4,3,4,4,4,5],
    lengths:[470,321,119,346,326,274,382,128,352,107,312,274,300,176,343,255,310,492],length:5287,
    tees:[{name:"Jaune",cr:69.6,slope:136,par:70,length:5287}]},
  {id:17,name:"Golf Ouest Provence Miramas",country:"France",par:71,
    si:[5,13,17,8,3,9,4,14,16,6,18,2,12,10,1,7,15,11],
    pars:[3,4,4,5,4,4,3,4,4,4,3,4,5,3,5,4,4,4],
    lengths:[134,305,294,393,326,243,121,329,317,379,112,289,452,148,433,300,322,346],length:5243,
    tees:[{name:"Jaune",cr:68.9,slope:124,par:71,length:5243}]},
  {id:18,name:"Golf Aix-Marseille (Les Milles)",country:"France",par:72,
    si:[5,8,14,4,13,3,15,17,7,6,18,9,11,10,2,12,1,16],
    pars:[4,5,3,4,3,4,5,3,4,4,5,4,5,3,4,3,4,5],
    lengths:[342,442,132,375,152,385,446,106,323,356,421,373,443,167,329,157,349,434],length:5732,
    tees:[{name:"Jaune",cr:71.6,slope:133,par:72,length:5732}]},
  {id:19,name:"Golf Resort Provence Sainte-Baume (Nans)",country:"France",par:72,
    si:[14,5,8,16,1,3,2,12,6,11,15,10,18,7,9,17,4,13],
    pars:[5,4,4,3,4,4,5,3,4,4,3,5,4,5,4,3,4,4],
    lengths:[422,313,340,167,370,330,430,163,363,319,162,436,322,411,297,160,360,324],length:5689,
    tees:[{name:"Jaune",cr:71.0,slope:125,par:72,length:5689}]},
  {id:20,name:"Golf de Servanes",country:"France",par:72,
    si:[18,13,4,5,1,14,3,9,8,17,15,2,7,16,10,12,11,6],
    pars:[4,3,4,5,4,3,4,4,5,4,4,3,5,4,3,4,4,5],
    lengths:[255,127,312,434,379,122,387,347,462,336,324,134,486,315,123,359,250,478],length:5630,
    tees:[{name:"Jaune",cr:71.0,slope:132,par:72,length:5630}]},
  {id:21,name:"Golf de la Cabre d'Or",country:"France",par:72,
    si:[13,5,9,1,15,11,7,17,3,16,10,18,4,14,2,12,8,6],
    pars:[5,5,4,4,4,3,4,3,4,4,4,3,5,3,4,4,4,5],
    lengths:[429,455,271,341,246,162,278,135,364,288,306,118,489,149,392,298,336,524],length:5581,
    tees:[{name:"Jaune",cr:70.4,slope:137,par:72,length:5581}]},
  {id:23,name:"Golf Dolce Frégate Provence",country:"France",par:71,
    si:[7,17,11,5,3,15,9,13,1,6,12,2,8,10,18,16,4,14],
    pars:[4,5,3,4,4,4,5,3,4,4,5,4,3,5,4,3,4,3],
    lengths:[300,425,145,315,296,223,465,135,347,379,412,371,177,408,267,106,353,144],length:5268,
    tees:[{name:"Jaune",cr:70.4,slope:126,par:71,length:5268}]},
  {id:24,name:"Golf d'Aix-en-Provence (Rouge)",country:"France",par:69,
    si:[9,16,8,7,17,1,18,6,15,2,3,14,5,10,4,12,11,13],
    pars:[5,4,3,3,4,4,4,3,4,3,4,3,4,5,4,5,3,4],
    lengths:[477,290,139,165,242,405,279,141,256,146,366,137,285,471,325,443,125,278],length:4970,
    tees:[{name:"Jaune",cr:67.2,slope:129,par:69,length:4970}]},
];

function Section({children}){return <div style={{fontFamily:"'Archivo',sans-serif",
  fontWeight:800,fontSize:13,letterSpacing:1.5,textTransform:"uppercase",
  color:T.dim,margin:"20px 0 10px"}}>{children}</div>;}
function Field({label,children}){return <label style={{flex:1,display:"block",marginTop:8}}>
  <span style={{fontSize:10,color:T.dim,textTransform:"uppercase",letterSpacing:.5,
    fontWeight:700}}>{label}</span>
  {children}</label>;}
function Pill({active,onClick,children}){return <button onClick={onClick} style={{flex:1,
  padding:"13px 14px",borderRadius:16,border:active?"none":`1.5px solid ${T.line}`,
  background:active?T.accent:"transparent",color:active?T.ink:T.text,
  fontWeight:800,fontSize:14,cursor:"pointer",
  boxShadow:active?`0 0 24px ${T.accent}44`:"none",transition:"all .15s"}}>
  {children}</button>;}
function Warn({children}){return <div style={{background:`${T.us}1a`,
  border:`1px solid ${T.us}55`,borderRadius:14,padding:12,fontSize:12,color:"#ff9b9b",
  marginTop:8}}>⚠️ {children}</div>;}
function Empty({text}){return <div style={{background:T.panel,borderRadius:16,
  textAlign:"center",color:T.dim,padding:"28px 18px",marginTop:30,
  border:`1px solid ${T.line}`}}>{text}</div>;}

const shell={fontFamily:"'Manrope',system-ui,sans-serif",background:T.bg,color:T.text,
  minHeight:"100vh",maxWidth:480,margin:"0 auto",paddingBottom:84};
// cartes : coins très arrondis, bordure fine, plus de bandeau latéral
const card=b=>({background:T.panel,border:`1px solid ${b}2e`,
  borderRadius:18,padding:14,marginBottom:11,boxShadow:"0 1px 0 rgba(255,255,255,.02)"});
const inp={width:"100%",background:"#0c130e",border:`1.5px solid ${T.line}`,color:T.text,
  borderRadius:14,padding:"12px 13px",fontSize:14,marginTop:4,outline:"none"};
// bouton principal = pilule vert fairway, glow léger
const addBtn={width:"100%",marginTop:14,padding:"15px",border:"none",borderRadius:18,
  background:T.accent,color:T.ink,fontWeight:800,fontSize:15,cursor:"pointer",
  boxShadow:`0 6px 24px ${T.accent}33`,letterSpacing:.3};
const delBtn={background:"transparent",border:`1.5px solid ${T.line}`,color:T.dim,
  borderRadius:12,padding:"7px 12px",cursor:"pointer",fontSize:12,fontWeight:700};
const miniBtn={border:`1.5px solid ${T.line}`,color:T.text,borderRadius:999,
  background:T.panel,padding:"6px 12px",cursor:"pointer",fontSize:11,fontWeight:800};
const chip={borderRadius:999,padding:"9px 15px",fontSize:13,cursor:"pointer",color:T.text,
  background:T.panel,fontWeight:800};
const cell={width:28,textAlign:"center",background:"#0c130e",border:`1.5px solid ${T.line}`,
  color:T.text,borderRadius:8,padding:"4px 0",fontSize:11,fontWeight:700};
const th={padding:"3px 1px",color:T.dim,fontSize:9,borderBottom:`1px solid ${T.line}`,
  fontWeight:800};
const td={padding:"3px 1px",textAlign:"center",borderBottom:`1px solid ${T.line}22`};
const tabbar={position:"fixed",bottom:0,left:0,right:0,maxWidth:480,margin:"0 auto",
  display:"flex",background:"rgba(8,13,10,.92)",backdropFilter:"blur(12px)",
  borderTop:`1px solid ${T.line}`,padding:"8px 4px 12px"};
const tabBtn={flex:1,background:"none",border:"none",cursor:"pointer",padding:"6px 2px",
  display:"flex",flexDirection:"column",alignItems:"center",gap:3};
const GLOBAL_CSS=`@import url('https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@600;700;800;900&family=Manrope:wght@400;500;600;700;800&display=swap');
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  input,select{font-family:inherit}
  body{background:#0a0f0c}
  ::selection{background:${T.accent};color:${T.ink}}
  @keyframes pop{0%{transform:scale(.7);opacity:0}60%{transform:scale(1.08)}100%{transform:scale(1);opacity:1}}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes glow{0%,100%{box-shadow:0 0 18px ${T.accent}33}50%{box-shadow:0 0 30px ${T.accent}66}}`;
