package com.example.order.api;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

  @GetMapping("/{id}")
  public Order getOrder(@PathVariable Long id) { return null; }

  @PostMapping
  public Order create(@RequestBody Order body) { return null; }
}
