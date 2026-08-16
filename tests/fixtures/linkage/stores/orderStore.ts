import { defineStore } from 'pinia';
import { useOrderData } from '../composables/useOrderData';

export const useOrderStore = defineStore('order', () => {
  const data = useOrderData();
  return { data };
});
