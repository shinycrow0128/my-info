// All requests go through the Vite dev proxy (/api -> http://localhost:5000).
const BASE = import.meta.env.VITE_API_URL || '';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options);
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const payload = isJson ? await res.json() : null;
  if (!res.ok) {
    throw new Error((payload && payload.error) || `Request failed (${res.status})`);
  }
  return payload;
}

export function getMeta() {
  return request('/api/meta');
}

export function getStats() {
  return request('/api/applications/stats');
}

export function listApplications(params) {
  const qs = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== '' && value !== null && value !== undefined) qs.set(key, value);
  });
  return request(`/api/applications?${qs.toString()}`);
}

export function createApplication(formData) {
  return request('/api/applications', { method: 'POST', body: formData });
}

export function updateApplication(id, formData) {
  return request(`/api/applications/${id}`, { method: 'PUT', body: formData });
}

export function deleteApplication(id) {
  return request(`/api/applications/${id}`, { method: 'DELETE' });
}

export function resumeUrl(id) {
  return `${BASE}/api/applications/${id}/resume`;
}

export function getAnalytics(days) {
  return request(`/api/analytics?days=${encodeURIComponent(days)}`);
}

// Backs the Ctrl+Shift+X peek panel: who applied to the selected company, and where it stands.
export function lookupCompany(term, limit) {
  const qs = new URLSearchParams({ q: term });
  if (limit) qs.set('limit', limit);
  return request(`/api/applications/company-lookup?${qs.toString()}`);
}
