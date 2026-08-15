import { Router } from 'express';

const router = Router();

router.get('/api/products', listProducts);
router.post('/api/orders', createOrder);
router.patch('/api/orders/:id', updateOrder);

function listProducts() {}
function createOrder() {}
function updateOrder() {}
