// Chargement des parcours depuis Supabase -> format de l'app ({ name, pars[18], si[18], ... }).
// Remplace le tableau de parcours codes en dur par un appel a loadCourses().
//
// Pre-requis : npm i @supabase/supabase-js
// et les tables courses/tees/holes importees (voir supabase/migrations + supabase/seed.sql).

import { createClient } from '@supabase/supabase-js';

// Mets tes vraies valeurs (idealement via variables d'env, pas en dur).
const SUPABASE_URL = import.meta?.env?.VITE_SUPABASE_URL || 'https://TON-PROJET.supabase.co';
const SUPABASE_ANON_KEY = import.meta?.env?.VITE_SUPABASE_ANON_KEY || 'TA_CLE_ANON';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Transforme une ligne Supabase en parcours au format attendu par l'app.
function toAppCourse(row) {
  const holes = [...(row.holes || [])].sort((a, b) => a.hole_number - b.hole_number);
  const pars = Array.from({ length: row.holes_count || 18 }, (_, i) => {
    const h = holes.find((x) => x.hole_number === i + 1);
    return h ? h.par : null;            // null = a completer (edition par/HCP trou par trou)
  });
  const si = Array.from({ length: row.holes_count || 18 }, (_, i) => {
    const h = holes.find((x) => x.hole_number === i + 1);
    return h ? h.stroke_index : null;
  });
  const lengths = Array.from({ length: row.holes_count || 18 }, (_, i) => {
    const h = holes.find((x) => x.hole_number === i + 1);
    return h ? h.length_m : null;
  });

  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    city: row.city,
    country: row.country,
    par: row.par,
    holesCount: row.holes_count,
    gps: row.lat != null ? { lat: row.lat, lng: row.lng } : null,
    tees: row.tees || [],
    pars,        // [18] - utilise par l'app
    si,          // [18] - stroke index
    lengths,     // [18] - longueurs (souvent null pour l'instant)
    confidence: row.confidence,
    notes: row.notes,
  };
}

// Charge tous les parcours (avec departs + trous) tries par nom.
export async function loadCourses() {
  const { data, error } = await supabase
    .from('courses')
    .select('*, tees(*), holes(*)')
    .order('name');
  if (error) throw error;
  return (data || []).map(toAppCourse);
}

// Sauvegarde un trou (pour l'ecran "edition par/HCP trou par trou").
export async function saveHole(courseId, holeNumber, { par, strokeIndex, lengthMeters }) {
  const { error } = await supabase
    .from('holes')
    .upsert(
      { course_id: courseId, hole_number: holeNumber, par, stroke_index: strokeIndex, length_m: lengthMeters },
      { onConflict: 'course_id,hole_number' }
    );
  if (error) throw error;
}
