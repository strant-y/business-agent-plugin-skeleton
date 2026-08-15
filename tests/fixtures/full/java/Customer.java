package com.example.order;

import jakarta.persistence.*;

@Entity
@Table(name = "customer")
public class Customer {

  @Id
  @Column(name = "id")
  private Long id;

  @Column(name = "name")
  private String name;

  @OneToMany(mappedBy = "customer")
  private List<Order> orders;

  public Long getId() { return id; }
  public String getName() { return name; }
}
