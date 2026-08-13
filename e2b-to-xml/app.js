"use strict";
const NS = "urn:hl7-org:v3";
const XSI = "http://www.w3.org/2001/XMLSchema-instance";

/* ---------------- helpers DOM con namespace ---------------- */
function dChildren(el, tag){ return el ? Array.from(el.children).filter(c => c.localName === tag) : []; }
function dChild(el, tag){ const r = dChildren(el, tag); return r.length ? r[0] : null; }
function findFirstDesc(el, tag){ if(!el) return null; const r = el.getElementsByTagNameNS(NS, tag); return r.length ? r[0] : null; }

/* ---------------- helpers de formato ---------------- */
function fmtDate(yyyymmdd){
  if(!yyyymmdd) return "NULL";
  const core = yyyymmdd.slice(0,8);
  if(!/^\d{8}$/.test(core)) return "NULL";
  return `${core.slice(6,8)}/${core.slice(4,6)}/${core.slice(0,4)}`;
}
function fmtTimestamp(value){
  if(!value) return "NULL";
  let core = value.replace(/[+-]\d{4}$/, "");
  if(core.length >= 14 && /^\d{14}/.test(core)){
    core = core.slice(0,14);
    return `${core.slice(8,10)}:${core.slice(10,12)} ${core.slice(6,8)}/${core.slice(4,6)}/${core.slice(0,4)}`;
  }
  const core8 = core.slice(0,8);
  if(/^\d{8}$/.test(core8)) return `00:00 ${core8.slice(6,8)}/${core8.slice(4,6)}/${core8.slice(0,4)}`;
  return "NULL";
}
function daysBetween(low, high){
  if(!low || !high) return "NULL";
  const l = low.slice(0,8), h = high.slice(0,8);
  if(!/^\d{8}$/.test(l) || !/^\d{8}$/.test(h)) return "NULL";
  const d1 = Date.UTC(+l.slice(0,4), +l.slice(4,6)-1, +l.slice(6,8));
  const d2 = Date.UTC(+h.slice(0,4), +h.slice(4,6)-1, +h.slice(6,8));
  return `${Math.round((d2-d1)/86400000)} DIAS`;
}
function up(s){ return (s && s.trim()) ? s.toUpperCase().trim() : "NULL"; }
function valOrNull(s){
  if(!s || !s.trim()) return "NULL";
  const t = s.trim();
  if(["none","n/a","na","not applicable"].includes(t.toLowerCase())) return "NULL";
  return t;
}
function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

const SEX_MAP = {"1":"MASCULINO","2":"FEMENINO","0":"NO ESPECIFICADO","9":"NO ESPECIFICADO"};
const AGE_UNIT_MAP = {"a":"A\u00d1OS","mo":"MESES","d":"D\u00cdAS","wk":"SEMANAS","h":"HORAS"};
const OUTCOME_MAP = {"1":"RECUPERADO","2":"RECUPERANDO","3":"NO RECUPERADO","4":"CON SECUELAS","5":"FALLECIDO","6":"DESCONOCIDO"};
const COUNTRY_MAP = {"PE":"PERU"};
const QUALIFICATION_MAP = {"1":"PROFESIONAL DE SALUD","2":"PROFESIONAL DE SALUD","3":"PROFESIONAL DE SALUD","4":"OTRO","5":"OTRO"};
const ICH_REPORT_TYPE_MAP = {"1":"NOTIF. ESPONTANEA","2":"ESTUDIO","3":"OTRO","4":"NO DISPONIBLE"};
const SERIOUSNESS_FIELDS = ["resultsInDeath","isLifeThreatening","requiresInpatientHospitalization",
  "resultsInPersistentOrSignificantDisability","congenitalAnomalyBirthDefect","otherMedicallyImportantCondition"];

/* ---------------- extraccion del E2B ---------------- */
function parseE2B(xmlText){
  const dom = new DOMParser().parseFromString(xmlText, "application/xml");
  if(dom.getElementsByTagName("parsererror").length){
    throw new Error("El archivo no es un XML válido (error de parseo).");
  }
  const inv = findFirstDesc(dom.documentElement, "investigationEvent");
  if(!inv) throw new Error("No se encontró <investigationEvent>. ¿Es un mensaje E2B / ICH ICSR (HL7 v3) válido?");

  const data = {};
  const idsEls = dChildren(inv, "id");
  data.safety_report_id = idsEls.length ? idsEls[0].getAttribute("extension") : null;

  const textEl = dChild(inv, "text");
  data.case_text = textEl ? textEl.textContent : null;

  const eff = dChild(inv, "effectiveTime");
  const lowEl = eff ? dChild(eff, "low") : null;
  data.receipt_date = lowEl ? lowEl.getAttribute("value") : null;

  const primaryRole = findFirstDesc(inv, "primaryRole");
  const player1 = dChild(primaryRole, "player1");
  const genderEl = dChild(player1, "administrativeGenderCode");
  data.sex_code = genderEl ? genderEl.getAttribute("code") : null;

  data.age = null; data.age_unit = null; data.weight = null; data.height = null; data.history_text = null;
  const reactions = [], drugs = [];

  for(const subj2 of dChildren(primaryRole, "subjectOf2")){
    const obs = dChild(subj2, "observation");
    if(obs){
      const codeEl = dChild(obs, "code");
      const dn = codeEl ? codeEl.getAttribute("displayName") : null;
      const valueEl = dChild(obs, "value");
      if(dn === "age" && valueEl){ data.age = valueEl.getAttribute("value"); data.age_unit = valueEl.getAttribute("unit"); }
      else if(dn === "weight" && valueEl){ data.weight = valueEl.getAttribute("value"); }
      else if(dn === "height" && valueEl){ data.height = valueEl.getAttribute("value"); }
      else if(dn === "reaction"){ reactions.push(parseReaction(obs, valueEl)); }
      continue;
    }
    const organizer = dChild(subj2, "organizer");
    if(organizer){
      const codeEl = dChild(organizer, "code");
      const dn = codeEl ? codeEl.getAttribute("displayName") : null;
      if(dn === "relevantMedicalHistoryAndConcurrentConditions"){
        const comp = dChild(organizer, "component");
        const o = comp ? dChild(comp, "observation") : null;
        const v = o ? dChild(o, "value") : null;
        data.history_text = v ? v.textContent : null;
      } else if(dn === "drugInformation"){
        for(const comp of dChildren(organizer, "component")){
          const sa = dChild(comp, "substanceAdministration");
          if(sa) drugs.push(parseDrug(sa));
        }
      }
    }
  }
  data.reactions = reactions; data.drugs = drugs;

  const roleByDrugId = {};
  const aea = findFirstDesc(inv, "adverseEventAssessment");
  if(aea){
    for(const comp of dChildren(aea, "component")){
      const ca = dChild(comp, "causalityAssessment");
      if(!ca) continue;
      const codeEl = dChild(ca, "code");
      if(!codeEl || codeEl.getAttribute("displayName") !== "interventionCharacterization") continue;
      const valueEl = dChild(ca, "value");
      const roleCode = valueEl ? valueEl.getAttribute("code") : null;
      const subj2 = dChild(ca, "subject2");
      const ref = subj2 ? findFirstDesc(subj2, "id") : null;
      const drugId = ref ? ref.getAttribute("root") : null;
      if(drugId) roleByDrugId[drugId] = roleCode;
    }
  }
  data.role_by_drug_id = roleByDrugId;

  data.doc_filename = null;
  for(const comp of dChildren(inv, "component")){
    const oe = dChild(comp, "observationEvent");
    if(!oe) continue;
    const codeEl = dChild(oe, "code");
    const dn = codeEl ? codeEl.getAttribute("displayName") : null;
    const valueEl = dChild(oe, "value");
    if(dn === "additionalDocumentsAvailable" && valueEl){
      const xt = valueEl.getAttributeNS(XSI, "type");
      if(xt === "ED") data.doc_filename = valueEl.textContent;
    }
  }

  data.ich_report_type_code = null;
  for(const subj2 of dChildren(inv, "subjectOf2")){
    const ic = dChild(subj2, "investigationCharacteristic");
    if(!ic) continue;
    const codeEl = dChild(ic, "code");
    const dn = codeEl ? codeEl.getAttribute("displayName") : null;
    const valueEl = dChild(ic, "value");
    if(dn === "ichReportType" && valueEl) data.ich_report_type_code = valueEl.getAttribute("code");
  }

  const subj1 = dChild(inv, "subjectOf1");
  const sender = {};
  if(subj1){
    const author = findFirstDesc(subj1, "author");
    const ae = author ? dChild(author, "assignedEntity") : null;
    if(ae){
      for(const t of dChildren(ae, "telecom")){
        const v = t.getAttribute("value") || "";
        if(v.startsWith("tel:")) sender.tel = v.slice(4);
        else if(v.startsWith("mailto:")) sender.mail = v.slice(7);
      }
      const person = dChild(ae, "assignedPerson");
      if(person){
        const nameEl = dChild(person, "name");
        const given = nameEl ? dChild(nameEl, "given") : null;
        const family = nameEl ? dChild(nameEl, "family") : null;
        sender.given = given ? given.textContent : null;
        sender.family = family ? family.textContent : null;
      }
      const org1 = dChild(ae, "representedOrganization");
      if(org1){
        const name1 = dChild(org1, "name");
        sender.org1 = name1 ? name1.textContent : null;
        const org2 = findFirstDesc(org1, "representedOrganization");
        const name2 = org2 ? dChild(org2, "name") : null;
        sender.org2 = name2 ? name2.textContent : null;
      }
    }
  }
  data.sender = sender;

  const source = {};
  for(const orel of dChildren(inv, "outboundRelationship")){
    const ri = dChild(orel, "relatedInvestigation");
    if(!ri) continue;
    const codeEl = dChild(ri, "code");
    const dn = codeEl ? codeEl.getAttribute("displayName") : null;
    if(dn !== "sourceReport") continue;
    const author = findFirstDesc(ri, "author");
    const ae = author ? dChild(author, "assignedEntity") : null;
    if(!ae) continue;
    const addr = dChild(ae, "addr");
    if(addr){
      const city = dChild(addr, "city"); const state = dChild(addr, "state");
      source.city = city ? city.textContent : null;
      source.state = state ? state.textContent : null;
    }
    const person = dChild(ae, "assignedPerson");
    if(person){
      const nameEl = dChild(person, "name");
      if(nameEl){
        const prefix = dChild(nameEl, "prefix"); const given = dChild(nameEl, "given"); const family = dChild(nameEl, "family");
        source.prefix = prefix ? prefix.textContent : null;
        source.given = given ? given.textContent : null;
        source.family = family ? family.textContent : null;
      }
      const qual = findFirstDesc(person, "asQualifiedEntity");
      const qualCode = qual ? dChild(qual, "code") : null;
      source.qualification_code = qualCode ? qualCode.getAttribute("code") : null;
    }
  }
  data.source_reporter = source;
  return data;
}

function parseReaction(obs, valueEl){
  const r = {};
  const idEl = dChild(obs, "id");
  r.id = idEl ? idEl.getAttribute("root") : null;
  const eff = dChild(obs, "effectiveTime");
  const low = eff ? dChild(eff, "low") : null, high = eff ? dChild(eff, "high") : null;
  r.low = low ? low.getAttribute("value") : null;
  r.high = high ? high.getAttribute("value") : null;
  r.meddra_code = valueEl ? valueEl.getAttribute("code") : null;
  const ot = valueEl ? dChild(valueEl, "originalText") : null;
  r.original_text = ot ? ot.textContent : null;
  r.translation = null; r.outcome_code = null; r.seriousness = {};
  for(const orel of dChildren(obs, "outboundRelationship2")){
    const o2 = dChild(orel, "observation");
    const codeEl = dChild(o2, "code");
    const dn = codeEl ? codeEl.getAttribute("displayName") : null;
    const v = dChild(o2, "value");
    if(dn === "reactionForTranslation" && v) r.translation = v.textContent;
    else if(dn === "outcome" && v) r.outcome_code = v.getAttribute("code");
    else if(SERIOUSNESS_FIELDS.includes(dn) && v) r.seriousness[dn] = v.getAttribute("value");
  }
  return r;
}

function parseDrug(sa){
  const d = {};
  const idEl = dChild(sa, "id");
  d.id = idEl ? idEl.getAttribute("root") : null;
  const kop = findFirstDesc(sa, "kindOfProduct");
  const nameEl = kop ? dChild(kop, "name") : null;
  d.name = nameEl ? nameEl.textContent : null;

  const approval = findFirstDesc(sa, "approval");
  if(approval){
    const aid = dChild(approval, "id");
    d.registro_sanitario = aid ? aid.getAttribute("extension") : null;
    const orgEl = findFirstDesc(approval, "playingOrganization");
    const orgName = orgEl ? dChild(orgEl, "name") : null;
    d.manufacturer = orgName ? orgName.textContent : null;
    const territoryEl = findFirstDesc(approval, "territory");
    const territoryCode = territoryEl ? dChild(territoryEl, "code") : null;
    d.country = territoryCode ? territoryCode.getAttribute("code") : null;
  } else { d.registro_sanitario = null; d.manufacturer = null; d.country = null; }

  d.generic_name = null; d.action_taken_code = null; d.causality = [];

  for(const orel of dChildren(sa, "outboundRelationship2")){
    const o2 = dChild(orel, "observation");
    const codeEl = dChild(o2, "code");
    const dn = codeEl ? codeEl.getAttribute("displayName") : null;

    if(dn === "substanceAndStrength"){
      for(const orel2 of dChildren(o2, "outboundRelationship2")){
        const o3 = dChild(orel2, "observation");
        const c3 = dChild(o3, "code");
        const dn3 = c3 ? c3.getAttribute("displayName") : null;
        const v3 = dChild(o3, "value");
        if(dn3 === "substanceName" && v3) d.generic_name = v3.textContent;
      }
    } else if(dn === "actionTaken"){
      const v = dChild(o2, "value");
      d.action_taken_code = v ? v.getAttribute("code") : null;
    } else if(dn === "causalityAssessment"){
      const eff = dChild(o2, "effectiveTime");
      const effVal = eff ? eff.getAttribute("value") : null;
      const valueEl = dChild(o2, "value");
      const classification = valueEl ? valueEl.textContent : null;
      let method=null, severity=null, comments=null;
      for(const orel3 of dChildren(o2, "outboundRelationship2")){
        const o4 = dChild(orel3, "observation");
        const c4 = dChild(o4, "code");
        const dn4 = c4 ? c4.getAttribute("displayName") : null;
        const v4 = dChild(o4, "value");
        if(dn4 === "causalityMethod" && v4) method = v4.textContent;
        else if(dn4 === "assessmentSeverity" && v4) severity = v4.textContent;
        else if(dn4 === "assessmentComments" && v4) comments = v4.textContent;
      }
      d.causality.push({effectiveTime: effVal, classification, method, severity, comments});
    }
  }
  return d;
}

/* ---------------- construccion del formato interno ---------------- */
function buildRazonDeCambio(pendientes){
  const now = new Date();
  const pad = n => String(n).padStart(2,"0");
  const nowStr = `${pad(now.getHours())}:${pad(now.getMinutes())} ${pad(now.getDate())}/${pad(now.getMonth()+1)}/${now.getFullYear()}`;
  const lines = [nowStr, "CONVERSOR_E2B", "Caso importado automáticamente desde mensaje E2B. Campos pendientes de revisión manual:"];
  for(const p of pendientes) lines.push(`- ${p}`);
  return lines.join("\n");
}

function buildInternal(data, codCasoOverride, vOverride){
  const pendientes = [];
  const safetyId = data.safety_report_id || "SIN-ID";
  
  let codCaso = codCasoOverride || safetyId;
  if (!codCasoOverride) {
    pendientes.push("No se ingresó un COD_CASO local. Se está usando el ID del E2B como código provisional.");
  }

  const anio = data.receipt_date ? data.receipt_date.slice(0,4) : "NULL";
  const vVal = String(vOverride || 1);
  const listFilt = `${codCaso}.${vVal}`;

  // Extraer N (correlativo numérico) del COD_CASO
  let nVal = "NULL";
  const m = codCaso.match(/(\d+)$/);
  if(m){
    let digits = m[1];
    const anioStr = anio !== "NULL" ? anio : String(new Date().getFullYear());
    const anio2 = anioStr.slice(2);
    if(digits.startsWith(anioStr) && digits.length > 4) digits = digits.slice(4);
    else if(digits.startsWith(anio2) && digits.length > 2) digits = digits.slice(2);
    nVal = String(parseInt(digits, 10));
  } else {
    pendientes.push("No se pudo estimar N (correlativo numérico) desde el COD_CASO.");
  }

  const reactions = data.reactions;
  const ramLookup = {};
  for(const rx of reactions){
    const key = (rx.translation || rx.original_text || "").trim().toLowerCase();
    if(key){ (ramLookup[key] = ramLookup[key] || []).push(rx); }
  }

  const ramRows = [];
  reactions.forEach((rx, i0) => {
    const i = i0+1;
    const idRam = `${listFilt}.R${i}`;
    rx._id_ram = idRam;
    ramRows.push({
      ID_RAM: idRam, N: String(i), LIST_FILT: listFilt, COD_CASO: codCaso, V: vVal,
      TIPO_REPORTE: null, TIPO_DE_EVENTO: "REACCION ADVERSA",
      "REACCI\u00d3N_ADVERSA": up(rx.original_text),
      "T\u00c9RMINO_PREFERIDO_MEDDRA": "NULL", SOC_MEDDRA: "NULL",
      F_INICIO: fmtDate(rx.low), F_FINAL: fmtDate(rx.high), DURACION: daysBetween(rx.low, rx.high),
      LISTADONO_LISTADO: "NULL", TIMESTAMP: null,
      "A\u00d1O": rx.low ? rx.low.slice(0,4) : anio,
    });
  });
  pendientes.push("TÉRMINO_PREFERIDO_MEDDRA y SOC_MEDDRA quedan en NULL: requieren diccionario MedDRA (MSSO).");
  pendientes.push("LISTADONO_LISTADO requiere comparar contra la Ficha Técnica/IPS del producto; no viaja en el E2B.");

  const medRows = [], conRows = [], assesRows = [];
  let medN=0, conN=0, assN=0;

  for(const drug of data.drugs){
    const role = data.role_by_drug_id[drug.id];
    const isConcomitant = role === "2";
    let idMed;
    if(isConcomitant){ conN++; idMed = `${listFilt}.C${conN}`; } else { medN++; idMed = `${listFilt}.P${medN}`; }
    const countryName = COUNTRY_MAP[drug.country] || drug.country || "NULL";

    if(isConcomitant){
      conRows.push({
        ID_MED: idMed, N: String(conN), LIST_FILT: listFilt, COD_CASO: codCaso, V: vVal, TIPO_REPORTE: null,
        NOMBRE_COMERCIAL: up(drug.name), NOMBRE_GENERICO: up(drug.generic_name),
        DOSIS:"NULL", FRECUENCIA:"NULL", VIA_ADMINISTRACION:"NULL",
        F_INICIO:"NULL", F_FINAL:"NULL", DURACION:"NULL",
        "MOTIVO_PRESCRIPCI\u00d3N":"NULL", CIE10:"NULL", TIMESTAMP: fmtTimestamp(data.receipt_date),
      });
    } else {
      medRows.push({
        ID_MED: idMed, N: String(medN), LIST_FILT: listFilt, COD_CASO: codCaso, V: vVal, TIPO_REPORTE: null,
        NOMBRE_COMERCIAL: up(drug.name), "NOMBRE_GEN\u00c9RICO": up(drug.generic_name),
        FABRICANTE: up(drug.manufacturer), PAIS: up(countryName),
        LOTE:"NULL", DOSIS:"NULL", FRECUENCIA:"NULL", "V\u00cdA_ADMINISTRACI\u00d3N":"NULL",
        F_INICIO:"NULL", F_FINAL:"NULL", DURACION:"NULL",
        "MOTIVO_DE_PRESCRIPCI\u00d3N":"NULL", CIE_10:"NULL", SOSPECHA_PROB_CALIDAD:"NULL",
        REGISTRO_SANITARIO: valOrNull(drug.registro_sanitario), F_VENCIMIENTO:"NULL",
        TIMESTAMP: fmtTimestamp(data.receipt_date),
      });
    }

    for(const ca of drug.causality){
      const comments = ca.comments || "";
      const mm = comments.match(/RAM:\s*([^|]+?)\s*\|/i);
      const ramTerm = mm ? mm[1].trim().toLowerCase() : null;
      let rx = null;
      if(ramTerm && ramLookup[ramTerm] && ramLookup[ramTerm].length) rx = ramLookup[ramTerm].shift();

      assN++;
      const idAlg = `${listFilt}.E${assN}`;
      const effTs = fmtTimestamp(ca.effectiveTime);
      const effAnio = ca.effectiveTime ? ca.effectiveTime.slice(0,4) : anio;
      const effMes = ca.effectiveTime ? String(parseInt(ca.effectiveTime.slice(4,6),10)) : "NULL";
      const idRam = rx ? rx._id_ram : "NULL";
      const reaccionTxt = rx ? up(rx.original_text) : up(ramTerm);
      if(rx){ for(const row of ramRows){ if(row.ID_RAM === rx._id_ram && row.TIMESTAMP === null) row.TIMESTAMP = effTs; } }

      let serio = "NO SERIO";
      if(rx){
        const flags = Object.values(rx.seriousness || {});
        if(flags.some(v => v === "true")) serio = "SERIO";
        else if(!flags.length || flags.every(v => v === null || v === undefined)) serio = "NULL";
      }

      assesRows.push({
        ID_ALGORIT: idAlg, N: String(assN), LIST_FILT: listFilt, COD_CASO: codCaso, V: vVal, TIPO_REPORTE: null,
        ID_RAM: idRam, REACCION_ADVERSA: reaccionTxt, ID_MED: idMed, PRODUCTO_SOSPECHOSO: up(drug.name),
        CATEGORIA_DE_CAUSALIDAD: up(ca.classification), SERIONO_SERIO: serio,
        ALGORITMO: valOrNull(ca.method), EVIDENCIA: valOrNull(data.doc_filename),
        TIMESTAMP: effTs, "A\u00d1O": effAnio, MES: effMes,
      });
    }
  }
  if(!data.drugs.length) pendientes.push("El E2B no trajo ningún substanceAdministration: MED_Entry/ASSES_Entry quedaron vacíos.");
  pendientes.push("LOTE, DOSIS, FRECUENCIA, VÍA_ADMINISTRACIÓN, fechas de tratamiento y motivo de prescripción quedan en NULL si el E2B de origen no los incluye.");

  const unresolved = Object.keys(ramLookup).filter(k => ramLookup[k].length);
  if(unresolved.length) pendientes.push(`No se pudo correlacionar por texto: ${unresolved.join(", ")}. Revisar ASSES_Entry manualmente.`);

  const sex = SEX_MAP[data.sex_code] || "NULL";
  const ageUnit = AGE_UNIT_MAP[data.age_unit] || "NULL";
  const fuenteInfo = ICH_REPORT_TYPE_MAP[data.ich_report_type_code] || "NULL";
  const sender = data.sender || {};
  const responsable = [sender.given, sender.family].filter(Boolean).join(" ") || null;
  const src = data.source_reporter || {};
  const notificadorNombre = [src.given, src.family].filter(Boolean).join(" ") || null;
  const notificadorCalif = QUALIFICATION_MAP[src.qualification_code] || "NULL";
  const cenafyt = (src.prefix || "").trim().toUpperCase() === "CENAFYT" ? "SI" : "NULL";

  const severidades = [];
  for(const d of data.drugs) for(const c of d.causality) if(c.severity) severidades.push(c.severity);
  const ordenSev = {"LEVE":1,"MODERADA":2,"GRAVE":3};
  let gravedad = "NULL";
  if(severidades.length) gravedad = up(severidades.reduce((a,b) => (ordenSev[b.trim().toUpperCase()]||0) > (ordenSev[a.trim().toUpperCase()]||0) ? b : a));

  const ordenOut = {"5":5,"3":4,"4":3,"2":2,"1":1,"6":0};
  const outcomeCodes = reactions.map(r => r.outcome_code).filter(Boolean);
  let desenlace = "NULL";
  if(outcomeCodes.length){ const worst = outcomeCodes.reduce((a,b) => (ordenOut[b]??-1) > (ordenOut[a]??-1) ? b : a); desenlace = OUTCOME_MAP[worst] || "NULL"; }

  const anyTrueFlag = reactions.some(rx => Object.values(rx.seriousness||{}).some(v => v === "true"));
  const desenlaceGrave = anyTrueFlag ? "APLICA - VERIFICAR CRITERIO" : "NO APLICA";
  const tipoReporte = "INICIAL";

  pendientes.push('TIPO_REPORTE se dejó como "INICIAL" por defecto; confirmar si corresponde "INICIAL-FINAL" u otro.');
  pendientes.push("ESTADO, VALIDEZ, DIA_CERO, fechas de flujo interno (contacto, envío a DIGEMID, reconciliación) no viajan en el E2B: quedan en NULL.");
  pendientes.push("S1, S2, R1 y R2 quedan en NULL: confirmar su significado contra el layout real de Base_datos_SRAM.xlsm.");
  pendientes.push(`NOTIFICADOR_PRIMARIO proviene de un bloque institucional/regulatorio (nombre reportado: "${notificadorNombre}"); revisar antes de usarlo en el CIOMS I.`);
  if(data.drugs.length && data.drugs[0].action_taken_code === "1"){
    pendientes.push('El fármaco sospechoso tiene actionTaken="Drug withdrawn" (medicamento retirado); dato clínicamente relevante sin columna en MED_Entry.');
  }

  const dataEntry = {
    LIST_FILT: listFilt, COD_CASO: codCaso, N: nVal, V: vVal, "A\u00d1O": anio,
    TIPO_REPORTE: tipoReporte, ESTADO: "NULL",
    "FECHA_RECEPCI\u00d3N": fmtDate(data.receipt_date),
    FECHA_CONTACTO_CON_NOTIFICADOR: "NULL", CANTIDAD_DE_INTENTOS_DE_CONTACTO: "NULL",
    DIA_CERO: "NULL", VALIDEZ: "NULL",
    "FECHA_ENV\u00cdO_A_DIGEMID": "NULL", FECHA_LIMITE_DE_ENVIO_A_DIGEMID: "NULL", "FECHA_DE_RECONCILIACI\u00d3N": "NULL",
    CODIGO_EREPORTING: valOrNull(data.safety_report_id),
    EREPORTING_INDUSTRIA: valOrNull(data.safety_report_id) || up(sender.org2 || sender.org1),
    "FUENTE_DE_INFORMACI\u00d3N": fuenteInfo, PROCEDENCIA: "NULL",
    PROVINCIA: up(src.city), DEPARTAMENTO: up(src.state),
    "La_persona_que_notifica_tambi\u00e9n_comunic\u00f3_al_CENAFyT": cenafyt,
    NOTIFICADOR_PRIMARIO: notificadorCalif, NOMBRES_Y_APELLIDOS: up(notificadorNombre),
    TELEFONO: "NULL", EDAD: "NULL", SEXO: "NULL", CORREO: "NULL",
    "INICIALES_O_CODIGO_DE_IDENTIFICACI\u00d3N": "NO DISPONIBLE (ENMASCARADO EN EL E2B)",
    EDAD2: valOrNull(data.age), UNIDAD: ageUnit, SEXO3: sex,
    "PESO_Kg": valOrNull(data.weight), TALLA: valOrNull(data.height),
    DIAGNOSTICO_PRINCIPAL: "NULL", CIE10: "NULL", TIPO_DE_EVENTO: "REACCION ADVERSA",
    RESUMEN_DEL_CASO: up(data.case_text),
    "DESCRIPCI\u00d3N_DE_LA_REACCI\u00d3N_ADVERSA": valOrNull(data.doc_filename),
    "REACCI\u00d3N_ADVERSA": reactions.map(r => up(r.original_text)).join(";") || "NULL",
    GRAVEDAD: gravedad, DESENLACE_GRAVE: desenlaceGrave, DESENLACE: desenlace,
    EXAMENES_DE_LABORATORIO: "NULL",
    "DATOS_RELEVANTES_HISTORIA_CL\u00cdNICA": valOrNull(data.history_text),
    NOMBRE_COMERCIAL: data.drugs.length ? up(data.drugs[0].name) : "NULL",
    S1: "NULL", S2: "NULL", R1: "NULL", R2: "NULL",
    TRATAMIENTO_DE_LA_RAM: "NULL", "DESCRIPCI\u00d3N_DE_TRATAMIENTO": "NULL",
    "Nombre_comercial_y_gen\u00e9rico": "NULL",
    Nombre_Responsable: up(responsable), Correo_Responsable: valOrNull(sender.mail), Telefono_Responsable: valOrNull(sender.tel),
    TIMESTAMP: fmtTimestamp(data.receipt_date), AUTOR: "NULL",
    RAZON_DE_CAMBIO: buildRazonDeCambio(pendientes),
  };

  for(const row of [...ramRows, ...medRows, ...conRows, ...assesRows]) row.TIPO_REPORTE = tipoReporte;
  for(const row of ramRows) if(row.TIMESTAMP === null) row.TIMESTAMP = fmtTimestamp(data.receipt_date);

  return { DATA_ENTRY: dataEntry, RAM_Entry: ramRows, MED_Entry: medRows, CON_Entry: conRows, ASSES_Entry: assesRows, _pendientes: pendientes };
}

function dictToXml(tag, obj){
  let s = `<${tag}>`;
  for(const [k,v] of Object.entries(obj)){ s += `<${k}>${esc(v===null||v===undefined?"":v)}</${k}>`; }
  return s + `</${tag}>`;
}
function buildXmlString(internal){
  let s = '<?xml version="1.0" encoding="UTF-8"?>\n<Caso>';
  s += dictToXml("DATA_ENTRY", internal.DATA_ENTRY);
  for(const section of ["RAM_Entry","MED_Entry","CON_Entry","ASSES_Entry"]){
    const rows = internal[section];
    if(!rows.length) continue;
    s += `<${section}>`;
    for(const row of rows) s += dictToXml("Registro", row);
    s += `</${section}>`;
  }
  return s + "</Caso>";
}

/* ---------------- UI ---------------- */
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const resultsCard = document.getElementById("resultsCard");
const resultsList = document.getElementById("resultsList");
const codCasoInput = document.getElementById("codCasoInput");
const vInput = document.getElementById("vInput");
const uploadCard = document.getElementById("uploadCard");
const btnReset = document.getElementById("btnReset");
const useE2bIdCheck = document.getElementById("useE2bIdCheck");

useE2bIdCheck.addEventListener("change", (e) => {
  const isChecked = e.target.checked;
  codCasoInput.disabled = isChecked;
  vInput.disabled = isChecked;
  if (isChecked) {
    codCasoInput.value = "";
    vInput.value = "";
  }
});

btnReset.addEventListener("click", () => {
  resultsList.innerHTML = "";
  fileInput.value = "";
  codCasoInput.value = "";
  vInput.value = "";
  useE2bIdCheck.checked = false;
  codCasoInput.disabled = false;
  vInput.disabled = false;
  resultsCard.style.display = "none";
  btnReset.style.display = "none";
  uploadCard.style.display = "block";
});

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("dragover", e => { e.preventDefault(); dropzone.classList.add("drag"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
dropzone.addEventListener("drop", e => {
  e.preventDefault(); dropzone.classList.remove("drag");
  handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener("change", e => handleFiles(e.target.files));

function handleFiles(fileList){
  if (!useE2bIdCheck.checked && (!codCasoInput.value.trim() || !vInput.value.trim())) {
    alert("Por favor, ingresa el COD_CASO y la Versión (V) o marca la casilla para usar el ID del E2B.");
    fileInput.value = "";
    return;
  }

  const files = Array.from(fileList).filter(f => f.name.toLowerCase().endsWith(".xml"));
  if(!files.length) return;
  uploadCard.style.display = "none";
  resultsCard.style.display = "block";
  btnReset.style.display = "flex";
  files.forEach(processFile);
}

function processFile(file){
  const card = document.createElement("div");
  card.className = "result";
  card.innerHTML = `<div class="result-title">${esc(file.name)}</div><div class="result-sub">Leyendo…</div>`;
  resultsList.appendChild(card);

  const reader = new FileReader();
  reader.onload = () => {
    try{
      const data = parseE2B(reader.result);
      const codOverride = codCasoInput.value.trim() || null;
      const vOverride = parseInt(vInput.value.trim(), 10) || 1;
      const internal = buildInternal(data, codOverride, vOverride);
      renderResult(card, file.name, data, internal);
    } catch(err){
      card.classList.add("error-card");
      card.innerHTML = `<h3>No se pudo convertir ${esc(file.name)}</h3><div class="result-sub">${esc(err.message)}</div>`;
    }
  };
  reader.onerror = () => {
    card.classList.add("error-card");
    card.innerHTML = `<h3>No se pudo leer ${esc(file.name)}</h3><div class="result-sub">Error de lectura del archivo.</div>`;
  };
  reader.readAsText(file, "UTF-8");
}

function renderResult(card, filename, data, internal){
  const de = internal.DATA_ENTRY;
  const nPend = internal._pendientes.length;
  const xmlStr = buildXmlString(internal);
  
  const outNameXml = `Caso_${de.COD_CASO}.${de.V}.xml`;
  const outNameZip = `CasePackage_${de.COD_CASO}.${de.V}.zip`;

  card.innerHTML = `
    <div class="result-head">
      <div>
        <div class="result-title">${esc(filename)} <span style="font-weight:400;color:var(--muted);">&rarr; ${esc(outNameZip)}</span></div>
        <div class="result-sub">COD_CASO: ${esc(de.COD_CASO)} &middot; LIST_FILT: ${esc(de.LIST_FILT)} &middot; EREPORTING_INDUSTRIA: ${esc(de.EREPORTING_INDUSTRIA)}</div>
      </div>
      <a class="btn btn-primary btn-sm btn-download" style="opacity: 0.6; pointer-events: none;">
        Generando ZIP...
      </a>
    </div>
    <div class="badges">
      <span class="badge green">${internal.RAM_Entry.length} reacción(es)</span>
      <span class="badge green">${internal.MED_Entry.length} sospechoso(s)</span>
      <span class="badge ${internal.CON_Entry.length ? "green" : "amber"}">${internal.CON_Entry.length} concomitante(s)</span>
      <span class="badge green">${internal.ASSES_Entry.length} evaluación(es) de causalidad</span>
      <span class="badge amber">${nPend} campo(s) a revisar</span>
    </div>
    <details>
      <summary>Ver los ${nPend} puntos pendientes de revisión manual</summary>
      <ul class="pend-list">${internal._pendientes.map(p => `<li>${esc(p)}</li>`).join("")}</ul>
    </details>
  `;

  if (typeof JSZip !== 'undefined') {
    const zip = new JSZip();
    zip.file(outNameXml, xmlStr);
    zip.folder("Attachments"); // La macro VBA suele esperar esta carpeta

    zip.generateAsync({type:"blob"}).then(function(content) {
      const url = URL.createObjectURL(content);
      const btn = card.querySelector(".btn-download");
      if(btn) {
        btn.href = url;
        btn.download = outNameZip;
        btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 16V4M12 4l-4 4M12 4l4 4"/><path d="M4 16v3a2 2 0 002 2h12a2 2 0 002-2v-3"/></svg> Descargar Paquete ZIP`;
        btn.style.opacity = "1";
        btn.style.pointerEvents = "auto";
      }
    });
  } else {
    // Fallback si no carga JSZip
    const blob = new Blob([xmlStr], {type: "application/xml"});
    const url = URL.createObjectURL(blob);
    const btn = card.querySelector(".btn-download");
    if(btn) {
      btn.href = url;
      btn.download = outNameXml;
      btn.innerHTML = `Descargar XML (Sin ZIP)`;
      btn.style.opacity = "1";
      btn.style.pointerEvents = "auto";
    }
  }
}
