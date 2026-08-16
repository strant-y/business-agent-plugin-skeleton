import axios from 'axios';

export function useOrderData() {
  return axios.get('/api/orders');
}
