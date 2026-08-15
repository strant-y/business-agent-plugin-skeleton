import { Router } from 'express';

const router = Router();

router.get('/api/orders', listOrders);
router.get('/api/orders/:id', getOrder);

function listOrders() {}
function getOrder() {}
