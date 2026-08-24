package com.example.order.api;

import org.springframework.web.bind.annotation.*;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.access.prepost.PreFilter;
import com.example.order.Order;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

  @GetMapping("/{id}")
  @PreAuthorize("hasRole('ORDER_VIEWER')")
  public Order getById(@PathVariable Long id) {
    return new Order();
  }

  @PostMapping
  @PreFilter("filterObject.status == 'DRAFT'")
  public Order create(@RequestBody Order order) {
    return order;
  }
}
