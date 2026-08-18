const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp, getDefaultAdminCredentials } = require('../server');

let app;

test.before(async () => {
  app = await createApp();
});

test('GET /api/health returns status ok', async () => {
  const response = await request(app).get('/api/health');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok' });
});

test('POST /api/enquiries validates required fields', async () => {
  const response = await request(app)
    .post('/api/enquiries')
    .send({ name: 'Jane Doe' });

  assert.equal(response.status, 400);
  assert.match(response.body.message, /contact/i);
});

test('POST /api/enquiries accepts a valid enquiry and stores it', async () => {
  const response = await request(app)
    .post('/api/enquiries')
    .send({
      name: 'Jane Doe',
      contact: 'jane@test.com',
      type: 'My own assets',
      details: 'I may have an old account at a bank.'
    });

  assert.equal(response.status, 201);
  assert.equal(response.body.enquiry.name, 'Jane Doe');
  assert.equal(response.body.enquiry.contact, 'jane@test.com');
  assert.equal(response.body.enquiry.status, 'new');
});

test('POST /api/admin/login authenticates the admin user', async () => {
  const { username, password } = getDefaultAdminCredentials();
  const response = await request(app)
    .post('/api/admin/login')
    .send({ username, password });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.user.username, username);
});

test('PATCH /api/admin/enquiries/:id/status updates the CRM status', async () => {
  const { username, password } = getDefaultAdminCredentials();
  const login = await request(app)
    .post('/api/admin/login')
    .send({ username, password });

  const enquiryId = 'case_test_status';
  const newStatus = 'in_review';

  const insertResult = await request(app)
    .post('/api/enquiries')
    .send({
      name: 'Status Tester',
      contact: 'status@test.com',
      type: 'Business or organization',
      details: 'Need a case status update.'
    });

  const createdId = insertResult.body.enquiry.id;

  const response = await request(app)
    .patch(`/api/admin/enquiries/${createdId}/status`)
    .set('Cookie', login.headers['set-cookie'])
    .send({ status: newStatus, note: 'Reviewed by admin' });

  assert.equal(response.status, 200);
  assert.equal(response.body.enquiry.status, newStatus);
  assert.equal(response.body.enquiry.note, 'Reviewed by admin');
});
