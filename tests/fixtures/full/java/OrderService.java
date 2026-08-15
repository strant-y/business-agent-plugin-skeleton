package com.example.order.service;

import org.springframework.stereotype.Service;
import com.example.order.Order;

@Service
public class OrderService {

  public void update(Order order) {
    if (order.getStatus().equals("AUDIT")) {
      throw new RuntimeException("cannot modify an order under audit");
    }
    order.save();
  }
}
