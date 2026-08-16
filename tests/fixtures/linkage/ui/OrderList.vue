<template>
  <div>
    <button :disabled="order.status === 'AUDIT'">Edit</button>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import axios from 'axios';
import { useOrderStore } from '../stores/orderStore';
import { useOrderData } from '../composables/useOrderData';

interface Order {
  id: string;
  status: string;
}

const orders = ref<Order[]>([]);

onMounted(async () => {
  const res = await axios.get('/api/orders');
  orders.value = res.data;
});
</script>
