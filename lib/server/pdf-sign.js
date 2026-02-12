'use strict';

const crypto = require('crypto');
const querystring = require('querystring');
const request = require('request');

// RECOMMENDED: set destination email with environment variable PDF_SIGN_DESTINATION_EMAIL.
// Fallback only: set this constant directly in code if env management is not available.
// Keep empty string to disable code-based fallback.
const PDF_SIGN_DESTINATION_EMAIL_IN_CODE = '';

const DOCUMENT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_STORED_DOCUMENTS = 500;
const sharedDocuments = new Map();

function buildMailgunAuthHeader (apiKey) {
  const token = Buffer.from(`api:${apiKey}`).toString('base64');
  return `Basic ${token}`;
}

function sanitizeBase64Pdf (pdfBase64) {
  if (!pdfBase64 || typeof pdfBase64 !== 'string') {
    return null;
  }

  return pdfBase64.replace(/^data:application\/pdf;base64,/, '');
}

function validatePdfBase64 (pdfBase64) {
  return /^[A-Za-z0-9+/=\n\r]+$/.test(pdfBase64);
}


function getDestinationEmailConfig () {
  if (process.env.PDF_SIGN_DESTINATION_EMAIL) {
    return {
      value: process.env.PDF_SIGN_DESTINATION_EMAIL,
      source: 'env:PDF_SIGN_DESTINATION_EMAIL',
      recommended: true
    };
  }

  if (PDF_SIGN_DESTINATION_EMAIL_IN_CODE) {
    return {
      value: PDF_SIGN_DESTINATION_EMAIL_IN_CODE,
      source: 'code:PDF_SIGN_DESTINATION_EMAIL_IN_CODE',
      recommended: false
    };
  }

  return {
    value: '',
    source: 'none',
    recommended: true
  };
}

function pruneSharedDocuments () {
  const now = Date.now();

  sharedDocuments.forEach((value, key) => {
    if (value.expiresAt <= now) {
      sharedDocuments.delete(key);
    }
  });

  while (sharedDocuments.size > MAX_STORED_DOCUMENTS) {
    const oldestKey = sharedDocuments.keys().next().value;
    sharedDocuments.delete(oldestKey);
  }
}

module.exports = function createPdfSignRouter () {
  const router = require('express').Router();

  const destinationEmailConfig = getDestinationEmailConfig();
  const destinationEmail = destinationEmailConfig.value;
  const senderEmail = process.env.PDF_SIGN_SENDER_EMAIL || 'pdf-signature@nightscout.local';
  const mailgunDomain = process.env.PDF_SIGN_MAILGUN_DOMAIN;
  const mailgunApiKey = process.env.PDF_SIGN_MAILGUN_API_KEY;

  router.post('/create-link', require('express').json({ limit: '20mb' }), (req, res) => {
    pruneSharedDocuments();

    const fileName = (req.body.fileName || 'document.pdf').trim();
    const pdfBase64 = sanitizeBase64Pdf(req.body.pdfBase64);

    if (!pdfBase64 || !validatePdfBase64(pdfBase64)) {
      return res.status(400).json({
        ok: false,
        error: 'A valid PDF (base64) is required.'
      });
    }

    const documentId = crypto.randomBytes(12).toString('hex');
    sharedDocuments.set(documentId, {
      fileName,
      pdfBase64,
      createdAt: Date.now(),
      expiresAt: Date.now() + DOCUMENT_TTL_MS
    });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const signLink = `${baseUrl}/pdf-sign?doc=${encodeURIComponent(documentId)}&name=${encodeURIComponent(fileName)}`;

    return res.json({
      ok: true,
      documentId,
      signLink,
      expiresAt: new Date(Date.now() + DOCUMENT_TTL_MS).toISOString()
    });
  });

  router.get('/document/:id', (req, res) => {
    pruneSharedDocuments();

    const doc = sharedDocuments.get(req.params.id);
    if (!doc) {
      return res.status(404).json({
        ok: false,
        error: 'Document not found or expired.'
      });
    }

    const pdfBuffer = Buffer.from(doc.pdfBase64, 'base64');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${doc.fileName.replace(/"/g, '')}"`);
    return res.send(pdfBuffer);
  });

  router.post('/submit', require('express').json({ limit: '15mb' }), (req, res) => {
    const signerName = (req.body.signerName || '').trim();
    const fileName = (req.body.fileName || 'signed-document.pdf').trim();
    const signedPdfRaw = sanitizeBase64Pdf(req.body.signedPdfBase64);

    if (!destinationEmail || !mailgunDomain || !mailgunApiKey) {
      return res.status(500).json({
        ok: false,
        error: 'Missing destination email configuration (PDF_SIGN_DESTINATION_EMAIL or PDF_SIGN_DESTINATION_EMAIL_IN_CODE).'
      });
    }

    if (!signerName || !signedPdfRaw) {
      return res.status(400).json({
        ok: false,
        error: 'Signer details and signed PDF are required.'
      });
    }

    if (!validatePdfBase64(signedPdfRaw)) {
      return res.status(400).json({
        ok: false,
        error: 'Signed PDF is not a valid base64 payload.'
      });
    }

    const messageData = {
      from: senderEmail,
      to: destinationEmail,
      subject: `[PDF Sign] ${signerName} signed ${fileName}`,
      text: [
        'A document was signed from the Nightscout PDF signing page.',
        '',
        `Signer Name: ${signerName}`,
        `Submitted At: ${new Date().toISOString()}`,
        `Reference: ${crypto.randomBytes(16).toString('hex')}`
      ].join('\n'),
      attachment: `data:application/pdf;name=${encodeURIComponent(fileName)};base64,${signedPdfRaw}`
    };

    request.post({
      url: `https://api.mailgun.net/v3/${mailgunDomain}/messages`,
      headers: {
        Authorization: buildMailgunAuthHeader(mailgunApiKey),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: querystring.stringify(messageData)
    }, (error, response, body) => {
      if (error) {
        return res.status(502).json({ ok: false, error: error.message });
      }

      if (!response || response.statusCode >= 300) {
        return res.status(502).json({
          ok: false,
          error: 'Mail service rejected the signed PDF submission.',
          statusCode: response ? response.statusCode : null,
          response: body
        });
      }

      return res.json({ ok: true });
    });
  });

  router.get('/health', (req, res) => {
    const configured = Boolean(
      destinationEmail &&
      process.env.PDF_SIGN_MAILGUN_DOMAIN &&
      process.env.PDF_SIGN_MAILGUN_API_KEY
    );

    res.json({
      ok: true,
      configured,
      storedDocuments: sharedDocuments.size,
      destinationEmailSource: destinationEmailConfig.source,
      destinationEmailRecommendation: configured && !destinationEmailConfig.recommended
        ? 'For production, prefer env var PDF_SIGN_DESTINATION_EMAIL instead of code constant.'
        : 'Using recommended destination email configuration.',
      notes: configured
        ? 'PDF signing email delivery is configured.'
        : 'Set PDF_SIGN_DESTINATION_EMAIL (recommended) or PDF_SIGN_DESTINATION_EMAIL_IN_CODE, plus PDF_SIGN_MAILGUN_DOMAIN and PDF_SIGN_MAILGUN_API_KEY.'
    });
  });

  return router;
};
