// Tonight-card aurora helpers. The data + model now live in js/aurora/ (shared with the Aurora tab and the globe layer);
// this file keeps the original API so js/tonight/tonight.js is unchanged.
import { getKpRows } from '../aurora/data.js';
export { geomagLat, assess } from '../aurora/model.js';

/** Kp forecast rows [{ t, kp }] (shared cache with the Aurora tab: one request, 10-minute TTL). */
export const fetchKp = getKpRows;
