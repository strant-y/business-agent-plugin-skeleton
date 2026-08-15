<template>
  <div>
    <OrderCard :order="selected" />
    <button :disabled="selected.status === 'AUDIT'">Edit</button>
    <p v-if="selected.status === 'DRAFT'">Draft order</p>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import axios from 'axios';
import OrderCard from '@/components/OrderCard.vue';

interface Order {
  id: string;
  status: 'DRAFT' | 'APPROVED';
}

defineProps<{ selected: Order }>();
defineEmits<{ change: [order: Order] }>();

const orders = ref<Order[]>([]);

onMounted(async () => {
  const res = await axios.get('/api/orders');
  orders.value = res.data;
});
</script>
